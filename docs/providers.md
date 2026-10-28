# Provider and OCR integration guide

## Connections and task models

`connections.json` in the active library stores connections and capability routes. `GET /api/connections` removes credentials and supplies presence flags. Blank key inputs retain saved keys. API clients can explicitly clear a secret with `clear_api_key: true` or `clear_secret_key: true`.

New media jobs snapshot connection settings when submitted. The analysis worker snapshots settings when it starts a paper. The interface disables automatic cross-provider fallback: an unsuccessful local call does not silently become a cloud request.

## Ollama model folders

`POST /api/model-storage/discover` accepts an optional absolute search `root`. It checks saved/environment/default locations and scans a bounded directory tree for sibling `manifests` and `blobs`. It skips dependency/system directories and symlinks, and reports candidates, model names, stale environment paths and incomplete searches. Windows discovery reads the current user environment so a long-running desktop process can recognize a changed folder.

Discovery does not move weights. A desktop-managed Ollama process receives the selected path as `OLLAMA_MODELS`. ResearchPal does not take over an already-running external service; restart that service with its new environment. Calls use the selected HTTP host, not a model-file path. See [Ollama storage documentation](https://docs.ollama.com/faq#where-are-models-stored).

## OpenRouter

Use `https://openrouter.ai/api/v1`, save your key and select exact model IDs by task. The adapter uses:

| Task | Endpoint contract |
| --- | --- |
| Text/vision | `POST /chat/completions`, text or image-content messages. |
| Embeddings | `POST /embeddings`. |
| Images | `GET /images/models`, `POST /images`, base64 image results. |
| Video | `GET /videos/models`, `POST /videos`, poll `/videos/{id}`, download `/videos/{id}/content`. |
| Speech | `POST /audio/speech`, model/voice/input, MP3 result. |

Remote video IDs are saved and polled without resubmission. Clips are downloaded server-side and combined with reviewed narration by FFmpeg. No key is exposed in a browser media URL. Image/motion rendering uses one provider generation per scene; long speech can use many requests. Confirm your provider's pricing and access before Generate.

Official references: [video](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), [images](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [speech](https://openrouter.ai/docs/guides/overview/multimodal/tts).

The custom compatible adapter expects `/chat/completions`, `/embeddings`, `/images/generations`, `/videos` and `/audio/speech` as applicable. Compatibility with one endpoint does not establish the others.

## ComfyUI and Automatic1111

ComfyUI discovery reads `/object_info`, including `CheckpointLoaderSimple` checkpoint choices. Export an **API-format** workflow from ComfyUI and upload it in Settings, then set the positive prompt node ID/input. The adapter submits `/prompt`, follows `/history/{prompt_id}` and downloads compatible `/view` outputs. Checkpoint selection can override `CheckpointLoaderSimple` nodes.

The workflow must expose saved image or MP4/WebM outputs. Custom video nodes with other output schemas require an adapter update. A connection currently holds one workflow; changing image/video roles may require replacing it.

Automatic1111 must run with `--api`. Discovery uses `/sdapi/v1/sd-models`; generation uses `/sdapi/v1/txt2img` and a temporary checkpoint override restored afterward. See [the official API guide](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API).

## Baidu Unlimited-OCR 2

This adapter refers to [baidu/Unlimited-OCR](https://github.com/baidu/Unlimited-OCR), not the separate Baidu general cloud OCR API.

1. Follow upstream GPU/SGLang setup in a separate environment. Its October 2026 instructions use a customized SGLang wheel. Do not install that serving runtime into ResearchPal's packaged Python environment.
2. Start that server and note its served model and address. The upstream example serves `Unlimited-OCR-2` on port `10000`.
3. Set ResearchPal's Unlimited-OCR connection base URL ending in `/v1`; assign its served model to the OCR route. Add a key only if the server requires one.
4. Optionally supply the serialized no-repeat logit processor produced by your SGLang environment, following upstream instructions. ResearchPal forwards it to the trusted server; it does not evaluate it locally.
5. Choose automatic scanned-page detection or Always OCR for complete PDF parsing.

The adapter renders ordered page images, sends the upstream multi-page prompt to `/chat/completions`, consumes streamed output and checks page markers/output-length completion. It has no fixed application page-count cutoff. Memory, request size and output budgets still limit practical workloads. No weights or GPU inference runtime are bundled, and live inference is not established by offline tests.

The model can emit structural markup. The adapter preserves that output with page markers rather than reproducing the full benchmark's cross-page object-merging postprocessor. Review complex tables/formulas/figure text in the resulting source.

The separate **Baidu cloud OCR** connection uses OAuth plus page-by-page `accurate_basic`. It is subject to your account's quota; it is not an unlimited-usage guarantee. See [Baidu OCR](https://ai.baidu.com/tech/ocr/general).

## Speech and export

- Device speech queues source parts with pause/resume, speed and part selection. Available voices and network behavior depend on the device.
- Windows offline speech uses System.Speech, temporary WAV files and bundled FFmpeg MP3 conversion. It is Windows-only.
- Edge uses edge-tts and needs network access.
- Cloud speech uses the selected compatible speech model and voice. Long documents require multiple requests.

Narration saves playable MP3 parts, a playlist and a combined MP3. Studio creates scene narration and local slides or external visuals, then assembles H.264/AAC MP4. Audio retains full scene narration even when a slide displays only key text. Motion clips loop when shorter than the narration.

Jobs report success, failure or interruption. Restarting the app does not automatically repeat a paid generation. An upstream video job can continue after local polling stops; check the provider dashboard before starting another.
