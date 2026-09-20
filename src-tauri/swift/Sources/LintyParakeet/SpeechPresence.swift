import CoreML
import FluidAudio
import Foundation

/// Whole-recording speech detection. The ASR samples are never cropped or
/// amplified. The second pass only rescues quiet speech for the detector.
public struct SpeechPresenceDetector: Sendable {
    private let manager: VadManager

    public init(manager: VadManager) {
        self.manager = manager
    }

    public func hasSpeech(_ samples: [Float]) async throws -> Bool {
        let segmentation = VadSegmentationConfig(
            minSpeechDuration: 0.1,
            maxSpeechDuration: .infinity,
            negativeThreshold: 0.15,
            negativeThresholdOffset: 0.15
        )
        // FluidAudio derives the entry threshold as negative + offset = 0.3.
        // process starts a fresh recurrent state for every recording/pass.
        if !(try await manager.segmentSpeech(samples, config: segmentation)).isEmpty {
            return true
        }
        let peak = samples.reduce(Float(0)) { max($0, abs($1)) }
        guard peak.isFinite, peak > 1e-10 else { return false }
        let gain = min(Float(1000), max(Float(1), 0.1 / peak))
        guard gain > 1 else { return false }
        let detectorSamples = samples.map { $0 * gain }
        return !(try await manager.segmentSpeech(detectorSamples, config: segmentation)).isEmpty
    }

    static func directory(in modelDirectory: URL) -> URL {
        modelDirectory.appendingPathComponent("speech-detector", isDirectory: true)
    }

    static func loadCached(in modelDirectory: URL) async throws -> SpeechPresenceDetector? {
        let bundle = directory(in: modelDirectory)
            .appendingPathComponent("Models", isDirectory: true)
            .appendingPathComponent(Repo.vad.folderName, isDirectory: true)
            .appendingPathComponent(ModelNames.VAD.sileroVadFile, isDirectory: true)
        guard FileManager.default.fileExists(atPath: bundle.path) else { return nil }
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndNeuralEngine
        let model = try MLModel(contentsOf: bundle, configuration: config)
        let detector = SpeechPresenceDetector(manager: VadManager(vadModel: model))
        try await detector.warmUp()
        return detector
    }

    private func warmUp() async throws {
        // Warm the same model/buffers used by dictation. hasSpeech starts fresh
        // recurrent state, so this synthetic input cannot affect a later word.
        _ = try await hasSpeech(Array(repeating: 0, count: VadManager.chunkSize))
    }

    static func download(
        in modelDirectory: URL, progress: DownloadUtils.ProgressHandler? = nil
    ) async throws -> SpeechPresenceDetector {
        let manager = try await VadManager(
            modelDirectory: directory(in: modelDirectory), progressHandler: progress
        )
        let detector = SpeechPresenceDetector(manager: manager)
        // Prepare the detector without producing a user transcript.
        try await detector.warmUp()
        return detector
    }
}

/// Share the prepared detector. An unavailable runtime slot permits speech;
/// normal model loading installs a warmed detector before returning readiness.
actor SpeechPresenceSlot {
    private var detector: SpeechPresenceDetector?

    func install(_ detector: SpeechPresenceDetector) {
        self.detector = detector
    }

    func hasSpeech(_ samples: [Float]) async throws -> Bool {
        guard let detector else { return true }
        return try await detector.hasSpeech(samples)
    }
}

/// Coalesce preparations when a model is unloaded/reloaded during a download.
actor SpeechPresenceDownloads {
    static let shared = SpeechPresenceDownloads()
    private var pending: [String: Task<SpeechPresenceDetector, Error>] = [:]

    func prepare(in directory: URL) async throws -> SpeechPresenceDetector {
        let key = directory.standardizedFileURL.path
        if let task = pending[key] { return try await task.value }
        let task = Task {
            if let cached = try await SpeechPresenceDetector.loadCached(in: directory) {
                return cached
            }
            return try await SpeechPresenceDetector.download(in: directory)
        }
        pending[key] = task
        defer { pending[key] = nil }
        return try await task.value
    }
}
