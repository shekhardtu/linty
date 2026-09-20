import Foundation
import AVFoundation
import XCTest
@testable import LintyParakeet

final class SpeechPresenceTests: XCTestCase {
    func testUnavailableDetectorPreservesRecording() async throws {
        let slot = SpeechPresenceSlot()
        let speechAllowed = try await slot.hasSpeech(Array(repeating: 0.001, count: 16000))
        XCTAssertTrue(speechAllowed, "A pending/failed model download must not discard dictation")
    }

    func testCacheProbeDoesNotStartDownloadOrCreateDirectories() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let detector = try await SpeechPresenceDetector.loadCached(in: directory)
        XCTAssertNil(detector)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testInstalledDetectorDoesNotCarrySpeechIntoSilence() async throws {
        guard let modelRoot = ProcessInfo.processInfo.environment["LINTY_VAD_TEST_MODEL_DIR"],
              let speechPath = ProcessInfo.processInfo.environment["LINTY_VAD_TEST_SPEECH_WAV"] else {
            throw XCTSkip("Set LINTY_VAD_TEST_MODEL_DIR and LINTY_VAD_TEST_SPEECH_WAV for the installed-model test")
        }
        let cached = try await SpeechPresenceDetector.loadCached(in: URL(fileURLWithPath: modelRoot))
        let detector = try XCTUnwrap(cached)
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: speechPath), commonFormat: .pcmFormatFloat32, interleaved: false)
        XCTAssertEqual(file.processingFormat.sampleRate, 16000)
        XCTAssertEqual(file.processingFormat.channelCount, 1)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let samples = Array(UnsafeBufferPointer(start: try XCTUnwrap(buffer.floatChannelData?[0]), count: Int(buffer.frameLength)))
        let speech = try await detector.hasSpeech(samples)
        XCTAssertTrue(speech)
        let first = try await detector.hasSpeech(Array(repeating: 0, count: 16000))
        let second = try await detector.hasSpeech(Array(repeating: 0, count: 16000))
        XCTAssertFalse(first)
        XCTAssertFalse(second)
    }
}
