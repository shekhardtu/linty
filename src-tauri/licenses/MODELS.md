Linty downloads model weights separately from the app. The app's MIT license does not replace the model authors' terms.

| Model | Attribution and published terms |
|---|---|
| Whisper Large V3 Turbo Q5 | OpenAI Whisper, converted/quantized for whisper.cpp by Georgi Gerganov and contributors. The [distribution](https://huggingface.co/ggerganov/whisper.cpp) declares MIT. Linty pins revision `5359861c739e955e79d9a303bcbc70fb988958b1`, size, and SHA-256 in `src-tauri/src/model_store.rs`. |
| Parakeet TDT 0.6B v3 | NVIDIA, with Core ML conversion by FluidInference. The [base model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) declares [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The [conversion page](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml) lists CC BY 4.0 in metadata but Apache 2.0 in its prose; this inventory preserves both upstream statements and the NVIDIA/FluidInference attribution. |
| Parakeet CTC 110M vocabulary model | NVIDIA, with Core ML conversion by FluidInference. The [distribution](https://huggingface.co/FluidInference/parakeet-ctc-110m-coreml) likewise lists CC BY 4.0 metadata and Apache 2.0 prose. See that page and its linked base model for the original terms. |
| S1-mini by Superwhisper | Optional cleanup model. Its full upstream [LICENSE](s1-mini/LICENSE) and [NOTICE](s1-mini/NOTICE), including attribution requirements, ship with Linty. |

Linty does not modify the downloaded weights. Core ML conversion and Whisper quantization are upstream adaptations. FluidAudio's software license is recorded separately in `THIRD_PARTY_NOTICES.txt`; software and weight licenses should not be conflated. Review the linked model terms when changing providers or redistributing weights.
