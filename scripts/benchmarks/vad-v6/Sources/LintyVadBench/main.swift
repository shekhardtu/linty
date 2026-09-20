import AVFoundation
import CoreML
import CryptoKit
import FluidAudio
import LintyParakeet
import Foundation

// Runs independently of the app. Model downloads are confined to the supplied
// benchmark cache. No microphone, settings, history, or transcript mutation.
struct Manifest: Decodable {
    let cases: [Fixture]
}

struct Fixture: Decodable {
    let name: String
    let wav: String
    let text: String
    let speech: Bool
    let category: String
}

struct Policy {
    let name: String
    let threshold: Float
    let minimumSpeech: Double
}

func readSamples(_ url: URL) throws -> [Float] {
    let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    guard file.processingFormat.sampleRate == 16_000,
          file.processingFormat.channelCount == 1,
          let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else { throw BenchError.invalidAudio(url.lastPathComponent) }
    try file.read(into: buffer)
    guard let channel = buffer.floatChannelData?[0] else { throw BenchError.invalidAudio(url.lastPathComponent) }
    return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
}

enum BenchError: Error {
    case usage
    case invalidAudio(String)
}

// Candidate: retain a very confident short answer, or two adjacent frames of
// moderate evidence. Single startup spikes on tones are not enough. Evaluated
// on both untouched input and the bounded detector-only gain pass.
func hasConfirmedSpeech(_ probabilities: [Float]) -> Bool {
    probabilities.contains { $0 >= 0.99 }
        || zip(probabilities, probabilities.dropFirst()).contains { $0 >= 0.3 && $1 >= 0.3 }
}

func run() async throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 3 else {
        print("Usage: LintyVadBench <manifest.json> <benchmark-cache-dir> <report.json>")
        throw BenchError.usage
    }
    let manifestURL = URL(fileURLWithPath: args[0])
    let modelCache = URL(fileURLWithPath: args[1], isDirectory: true)
    let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
    let policies = [
        Policy(name: "fluidaudio-default", threshold: 0.85, minimumSpeech: 0.15),
        Policy(name: "silero-default", threshold: 0.5, minimumSpeech: 0.25),
        Policy(name: "lenient", threshold: 0.2, minimumSpeech: 0.1),
        Policy(name: "balanced", threshold: 0.3, minimumSpeech: 0.1),
        Policy(name: "presence-0.1", threshold: 0.1, minimumSpeech: 0),
        Policy(name: "presence-0.05", threshold: 0.05, minimumSpeech: 0),
    ]
    let loadStart = Date()
    let manager = try await VadManager(modelDirectory: modelCache)
    let production = SpeechPresenceDetector(manager: manager)
    let loadMS = Date().timeIntervalSince(loadStart) * 1000
    var rows: [[String: Any]] = []
    for fixture in manifest.cases {
        let url = manifestURL.deletingLastPathComponent().appendingPathComponent(fixture.wav)
        let samples = try readSamples(url)
        let started = Date()
        // process starts from VadState.initial() on each call, carrying state
        // sequentially across the 4096-sample frames within this recording.
        let frames = try await manager.process(samples)
        let elapsed = Date().timeIntervalSince(started) * 1000
        let probabilities = frames.map(\.probability)
        // Experimental rescue: boost a separate detector input, never ASR
        // samples. Limit amplification to 60 dB and never attenuate audio.
        let peak = samples.map { abs($0) }.max() ?? 0
        let gain: Float = peak > 1e-10 ? min(1000, max(1, 0.1 / peak)) : 1
        let rescueStarted = Date()
        let rescueFrames = gain > 1 ? try await manager.process(samples.map { $0 * gain }) : frames
        let rescueMS = gain > 1 ? Date().timeIntervalSince(rescueStarted) * 1000 : 0
        var decisions: [[String: Any]] = []
        for policy in policies {
            // segmentSpeech derives entry threshold from negative + offset.
            let offset = min(Float(0.15), policy.threshold - 0.01)
            let config = VadSegmentationConfig(
                minSpeechDuration: policy.minimumSpeech,
                maxSpeechDuration: .infinity,
                negativeThreshold: policy.threshold - offset,
                negativeThresholdOffset: offset
            )
            let segments = await manager.segmentSpeech(from: frames, totalSamples: samples.count, config: config)
            let pass = !segments.isEmpty
            decisions.append([
                "policy": policy.name, "threshold": policy.threshold,
                "minimumSpeechMs": policy.minimumSpeech * 1000,
                "passes": pass, "dropsSpeech": fixture.speech && !pass,
                "passesNoise": !fixture.speech && pass,
                "segments": segments.map { ["start": $0.startTime, "end": $0.endTime] },
            ])
        }
        for threshold: Float in [0.85, 0.5, 0.3] {
            let offset: Float = 0.15
            let config = VadSegmentationConfig(
                minSpeechDuration: 0.1, maxSpeechDuration: .infinity,
                negativeThreshold: threshold - offset, negativeThresholdOffset: offset
            )
            let original = await manager.segmentSpeech(from: frames, totalSamples: samples.count, config: config)
            let rescue = await manager.segmentSpeech(from: rescueFrames, totalSamples: samples.count, config: config)
            let pass = !original.isEmpty || !rescue.isEmpty
            decisions.append([
                "policy": "gain-rescue-\(threshold)", "threshold": threshold,
                "minimumSpeechMs": 100, "passes": pass,
                "dropsSpeech": fixture.speech && !pass,
                "passesNoise": !fixture.speech && pass,
            ])
        }
        let confirmed = hasConfirmedSpeech(probabilities) || hasConfirmedSpeech(rescueFrames.map(\.probability))
        decisions.append([
            "policy": "confirmed-gain", "passes": confirmed,
            "dropsSpeech": fixture.speech && !confirmed,
            "passesNoise": !fixture.speech && confirmed,
        ])
        let productionStart = Date()
        let productionPass = try await production.hasSpeech(samples)
        let productionMS = Date().timeIntervalSince(productionStart) * 1000
        let selected = decisions.first { $0["policy"] as? String == "gain-rescue-0.3" }!["passes"] as! Bool
        precondition(productionPass == selected, "Production policy differs for \(fixture.name)")
        rows.append([
            "name": fixture.name, "category": fixture.category,
            "expectedSpeech": fixture.speech, "expectedText": fixture.text,
            "sha256": SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined(),
            "seconds": Double(samples.count) / 16000,
            "milliseconds": elapsed, "probabilities": probabilities,
            "maxProbability": probabilities.max() ?? 0,
            "detectorGain": gain, "rescueMilliseconds": rescueMS,
            "rescueProbabilities": rescueFrames.map(\.probability),
            "productionPass": productionPass, "productionMilliseconds": productionMS,
            "policies": decisions,
        ])
        print("VAD \(fixture.name): max=\(probabilities.max() ?? 0), speech=\(fixture.speech)")
    }
    var summaries: [[String: Any]] = []
    for policyName in policies.map(\.name) + ["gain-rescue-0.85", "gain-rescue-0.5", "gain-rescue-0.3", "confirmed-gain"] {
        let decisions = rows.flatMap { $0["policies"] as! [[String: Any]] }
            .filter { $0["policy"] as? String == policyName }
        summaries.append([
            "policy": policyName,
            "droppedSpeech": decisions.filter { $0["dropsSpeech"] as? Bool == true }.count,
            "passedNoise": decisions.filter { $0["passesNoise"] as? Bool == true }.count,
        ])
    }
    let report: [String: Any] = [
        "model": "silero-vad-unified-256ms-v6.0.0", "fluidAudio": "0.14.8",
        "computeUnits": "cpuAndNeuralEngine", "frameSamples": VadManager.chunkSize,
        "loadMilliseconds": loadMS, "speechCases": manifest.cases.filter(\.speech).count,
        "noiseCases": manifest.cases.filter { !$0.speech }.count,
        "summary": summaries, "results": rows,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: URL(fileURLWithPath: args[2]), options: .atomic)
    print(String(data: try JSONSerialization.data(withJSONObject: summaries, options: .sortedKeys), encoding: .utf8)!)
}

try await run()
