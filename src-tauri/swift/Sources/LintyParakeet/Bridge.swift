import Darwin
import FluidAudio
import Foundation

// C ABI consumed by src-tauri/src/parakeet.rs. Every function is synchronous:
// FluidAudio's API is async, so each call parks the calling thread on a
// semaphore until the underlying Task completes. Callers must therefore never
// invoke these from the main thread — Rust wraps them in spawn_blocking.
//
// Strings returned through `out_*` parameters are malloc'd and must be released
// with `linty_parakeet_free_string`.

/// A loaded Parakeet TDT model plus the actor that runs inference on it.
final class ParakeetEngine {
    let manager: AsrManager
    let models: AsrModels
    let speechPresence = SpeechPresenceSlot()
    /// CTC keyword-spotter models for custom-vocabulary rescoring (optional; see linty_parakeet_load_ctc).
    var ctcModels: CtcModels?
    var ctcDirectory: URL?
    /// Tokenizer for the CTC vocabulary; terms must carry CTC token ids or the
    /// keyword spotter silently skips them.
    var ctcTokenizer: CtcTokenizer?

    init(manager: AsrManager, models: AsrModels) {
        self.manager = manager
        self.models = models
    }
}

/// Result slot shared between the calling thread and the async Task.
private final class ResultBox<T>: @unchecked Sendable {
    var value: Result<T, Error>?
}

/// Run an async operation to completion from a synchronous, non-main thread.
private func runBlocking<T>(_ body: @escaping @Sendable () async throws -> T) -> Result<T, Error> {
    let box = ResultBox<T>()
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached(priority: .userInitiated) {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    return box.value ?? .failure(BridgeError.noResult)
}

private enum BridgeError: LocalizedError {
    case noResult
    case invalidArgument(String)

    var errorDescription: String? {
        switch self {
        case .noResult: return "Operation produced no result"
        case .invalidArgument(let what): return "Invalid argument: \(what)"
        }
    }
}

private func describe(_ error: Error) -> String {
    if let localized = (error as? LocalizedError)?.errorDescription {
        return localized
    }
    return String(describing: error)
}

private func setError(_ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?, _ message: String) {
    out?.pointee = strdup(message)
}

private func modelDirectory(_ path: UnsafePointer<CChar>) -> URL {
    URL(fileURLWithPath: String(cString: path), isDirectory: true)
}

/// C progress callback: (fraction in 0...1, opaque context).
public typealias LintyProgressFn = @convention(c) (Double, UnsafeMutableRawPointer?) -> Void

/// Wraps the C callback so it can cross into a @Sendable closure.
private struct ProgressSink: @unchecked Sendable {
    let fn: LintyProgressFn?
    let ctx: UnsafeMutableRawPointer?

    func report(_ fraction: Double) {
        fn?(fraction, ctx)
    }
}

// MARK: - Exports

/// 1 when this machine can run the CoreML Parakeet models (Apple Silicon).
@_cdecl("linty_parakeet_is_supported")
public func linty_parakeet_is_supported() -> Int32 {
    return SystemInfo.isAppleSilicon ? 1 : 0
}

/// 1 when a complete Parakeet TDT v3 bundle exists at `dir`.
@_cdecl("linty_parakeet_models_exist")
public func linty_parakeet_models_exist(_ dir: UnsafePointer<CChar>?) -> Int32 {
    guard let dir else { return 0 }
    return AsrModels.modelsExist(at: modelDirectory(dir), version: .v3) ? 1 : 0
}

/// Download (or verify) the Parakeet TDT v3 bundle into `dir`.
/// `progress` receives the download+compile fraction on an arbitrary thread.
@_cdecl("linty_parakeet_download")
public func linty_parakeet_download(
    _ dir: UnsafePointer<CChar>?,
    _ progress: LintyProgressFn?,
    _ ctx: UnsafeMutableRawPointer?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let dir else {
        setError(outError, "missing model directory")
        return -1
    }
    let url = modelDirectory(dir)
    let sink = ProgressSink(fn: progress, ctx: ctx)

    let result = runBlocking { () -> URL in
        let downloaded = try await AsrModels.download(
            to: url,
            version: .v3,
            progressHandler: { snapshot in sink.report(snapshot.fractionCompleted * 0.98) }
        )
        _ = try await SpeechPresenceDetector.download(
            in: url, progress: { snapshot in sink.report(0.98 + snapshot.fractionCompleted * 0.02) }
        )
        sink.report(1)
        return downloaded
    }

    switch result {
    case .success:
        return 0
    case .failure(let error):
        setError(outError, describe(error))
        return -1
    }
}

/// Load the bundle at `dir` onto the Neural Engine. Returns an opaque handle
/// that must be released with `linty_parakeet_free`, or NULL on failure.
@_cdecl("linty_parakeet_load")
public func linty_parakeet_load(
    _ dir: UnsafePointer<CChar>?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> UnsafeMutableRawPointer? {
    guard let dir else {
        setError(outError, "missing model directory")
        return nil
    }
    let url = modelDirectory(dir)

    let result = runBlocking { () -> ParakeetEngine in
        let models = try await AsrModels.load(from: url, version: .v3)
        let manager = AsrManager()
        try await manager.loadModels(models)
        let engine = ParakeetEngine(manager: manager, models: models)
        // Ready means the installed detector has completed real inference,
        // including on fresh installs, subsequent launches and idle reloads.
        let detector = try await SpeechPresenceDownloads.shared.prepare(in: url)
        await engine.speechPresence.install(detector)
        return engine
    }

    switch result {
    case .success(let engine):
        return Unmanaged.passRetained(engine).toOpaque()
    case .failure(let error):
        setError(outError, describe(error))
        return nil
    }
}

/// Separate from transcription so synthetic ASR warm-up still runs the decoder.
@_cdecl("linty_parakeet_has_speech")
public func linty_parakeet_has_speech(
    _ handle: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let handle, let samples else {
        setError(outError, "Missing engine or audio")
        return -1
    }
    let engine = Unmanaged<ParakeetEngine>.fromOpaque(handle).takeUnretainedValue()
    let audio = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    switch runBlocking({ try await engine.speechPresence.hasSpeech(audio) }) {
    case .success(let speech): return speech ? 1 : 0
    case .failure(let error):
        setError(outError, describe(error))
        return -1
    }
}

/// Transcribe 16 kHz mono f32 samples. `language` is an optional ISO 639-1
/// code used as a script hint (v3 only); pass NULL for auto-detection.
/// Each call uses a fresh decoder state so utterances never bleed into each other.
@_cdecl("linty_parakeet_transcribe")
public func linty_parakeet_transcribe(
    _ handle: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ language: UnsafePointer<CChar>?,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ outProcessingSecs: UnsafeMutablePointer<Double>?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let handle else {
        setError(outError, "engine not loaded")
        return -1
    }
    guard let samples, count > 0 else {
        setError(outError, "no audio samples")
        return -1
    }

    let engine = Unmanaged<ParakeetEngine>.fromOpaque(handle).takeUnretainedValue()
    let audio = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    let hint: Language? = language.flatMap { Language(rawValue: String(cString: $0)) }
    let decoderLayers = engine.models.version.decoderLayers

    let result = runBlocking { () -> ASRResult in
        var state = try TdtDecoderState(decoderLayers: decoderLayers)
        return try await engine.manager.transcribe(audio, decoderState: &state, language: hint)
    }

    switch result {
    case .success(let asr):
        outText?.pointee = strdup(asr.text)
        outProcessingSecs?.pointee = asr.processingTime
        return 0
    case .failure(let error):
        setError(outError, describe(error))
        return -1
    }
}

/// Release a handle returned by `linty_parakeet_load` and drop its CoreML models.
@_cdecl("linty_parakeet_free")
public func linty_parakeet_free(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    let engine = Unmanaged<ParakeetEngine>.fromOpaque(handle).takeRetainedValue()
    _ = runBlocking { () -> Void in
        await engine.manager.cleanup()
    }
}

@_cdecl("linty_parakeet_free_string")
public func linty_parakeet_free_string(_ s: UnsafeMutablePointer<CChar>?) {
    free(s)
}

// MARK: - Custom vocabulary (CTC keyword spotter)

private struct VocabTermDTO: Decodable {
    let text: String
    let aliases: [String]?
}

private struct ReplacementDTO: Encodable {
    let from: String
    let to: String
    /// Whether FluidAudio's rescorer would apply it on its own.
    let apply: Bool
    let reason: String
}

/// Download (if needed) and load the Parakeet CTC 110M models into `dir`.
/// They power FluidAudio's custom-vocabulary rescoring alongside the TDT model.
@_cdecl("linty_parakeet_load_ctc")
public func linty_parakeet_load_ctc(
    _ handle: UnsafeMutableRawPointer?,
    _ dir: UnsafePointer<CChar>?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let handle else {
        setError(outError, "engine not loaded")
        return -1
    }
    guard let dir else {
        setError(outError, "missing CTC model directory")
        return -1
    }
    let engine = Unmanaged<ParakeetEngine>.fromOpaque(handle).takeUnretainedValue()
    let url = modelDirectory(dir)
    let result = runBlocking { () -> (CtcModels, CtcTokenizer) in
        let models = try await CtcModels.downloadAndLoad(to: url, variant: .ctc110m)
        let tokenizer = try await CtcTokenizer.load(from: url)
        // Exercise CTC itself: silent TDT warm-up can return before reaching
        // this optional vocabulary path. Discard all synthetic results.
        let spotter = CtcKeywordSpotter(models: models, blankId: models.vocabulary.count)
        _ = try await spotter.spotKeywordsWithLogProbs(
            audioSamples: Array(repeating: 0, count: 16000),
            customVocabulary: CustomVocabularyContext(terms: []), minScore: nil)
        return (models, tokenizer)
    }
    switch result {
    case .success(let (models, tokenizer)):
        engine.ctcModels = models
        engine.ctcTokenizer = tokenizer
        engine.ctcDirectory = url
        return 0
    case .failure(let error):
        setError(outError, describe(error))
        return -1
    }
}

/// Transcribe, then rescore the transcript against `termsJson`
/// (`[{"text":"Tauri","aliases":["Tari"]}]`) using the CTC keyword spotter.
/// `outReplacementsJson` receives `[{"from":"Tari","to":"Tauri"}]` for every
/// word the rescorer swapped.
@_cdecl("linty_parakeet_transcribe_vocab")
public func linty_parakeet_transcribe_vocab(
    _ handle: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ language: UnsafePointer<CChar>?,
    _ termsJson: UnsafePointer<CChar>?,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ outReplacementsJson: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?,
    _ outProcessingSecs: UnsafeMutablePointer<Double>?,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let handle else {
        setError(outError, "engine not loaded")
        return -1
    }
    guard let samples, count > 0 else {
        setError(outError, "no audio samples")
        return -1
    }
    let engine = Unmanaged<ParakeetEngine>.fromOpaque(handle).takeUnretainedValue()
    guard let ctcModels = engine.ctcModels, let tokenizer = engine.ctcTokenizer else {
        setError(outError, "CTC models not loaded; call linty_parakeet_load_ctc first")
        return -1
    }
    let terms: [VocabTermDTO]
    do {
        let json = termsJson.map { String(cString: $0) } ?? "[]"
        terms = try JSONDecoder().decode([VocabTermDTO].self, from: Data(json.utf8))
    } catch {
        setError(outError, "invalid vocabulary JSON: \(describe(error))")
        return -1
    }
    let vocabulary = CustomVocabularyContext(
        terms: terms.map {
            CustomVocabularyTerm(text: $0.text, aliases: $0.aliases, ctcTokenIds: tokenizer.encode($0.text))
        }
    )
    let audio = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    let hint: Language? = language.flatMap { Language(rawValue: String(cString: $0)) }
    let decoderLayers = engine.models.version.decoderLayers
    let ctcDirectory = engine.ctcDirectory

    let result = runBlocking { () -> (String, [ReplacementDTO], Double) in
        let started = Date()
        var state = try TdtDecoderState(decoderLayers: decoderLayers)
        let asr = try await engine.manager.transcribe(audio, decoderState: &state, language: hint)
        guard let timings = asr.tokenTimings, !timings.isEmpty else {
            return (asr.text, [], Date().timeIntervalSince(started))
        }
        let spotter = CtcKeywordSpotter(models: ctcModels, blankId: ctcModels.vocabulary.count)
        let spot = try await spotter.spotKeywordsWithLogProbs(
            audioSamples: audio, customVocabulary: vocabulary, minScore: nil)
        guard !spot.logProbs.isEmpty else {
            return (asr.text, [], Date().timeIntervalSince(started))
        }
        let rescorer = try await VocabularyRescorer.create(
            spotter: spotter, vocabulary: vocabulary, config: .default, ctcModelDirectory: ctcDirectory)
        let sizeConfig = ContextBiasingConstants.rescorerConfig(forVocabSize: vocabulary.terms.count)
        let minSimilarity = max(sizeConfig.minSimilarity, vocabulary.minSimilarity)
        let output = rescorer.ctcTokenRescore(
            transcript: asr.text,
            tokenTimings: timings,
            logProbs: spot.logProbs,
            frameDuration: spot.frameDuration,
            cbw: sizeConfig.cbw,
            marginSeconds: 0.5,
            minSimilarity: minSimilarity)
        let pairs = output.replacements.compactMap { r -> ReplacementDTO? in
            guard let to = r.replacementWord else { return nil }
            return ReplacementDTO(from: r.originalWord, to: to, apply: r.shouldReplace, reason: r.reason)
        }
        // Hand back the untouched TDT text; the caller decides which candidates to apply.
        return (asr.text, pairs, Date().timeIntervalSince(started))
    }

    switch result {
    case .success(let (text, pairs, secs)):
        outText?.pointee = strdup(text)
        let json = (try? JSONEncoder().encode(pairs)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        outReplacementsJson?.pointee = strdup(json)
        outProcessingSecs?.pointee = secs
        return 0
    case .failure(let error):
        setError(outError, describe(error))
        return -1
    }
}
