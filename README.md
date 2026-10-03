<p align="center"><img src="build/icon.png" alt="Ilyra" width="128"></p>

<h1 align="center">Ilyra</h1>

A desktop AI launcher for Windows. Bring your own keys for Claude, ChatGPT, Gemini and Meta, or run a model on your own computer, and use them all from one conversation: pick a model per message, or let Ilyra route each message to the one that suits it.

Keys are pasted into **Settings, AI models**, encrypted with Windows' per-user protection (Electron `safeStorage`) and stored only on that computer. They never reach the page itself, only the main process that calls each provider, and they go to that provider and nowhere else.

## What Ilyra can do

- **Chat with Claude, ChatGPT, Gemini and Meta.** Replies stream in, with the model's thinking, the steps it took and its sources folded beside them. If a model is retired, overloaded or out of credit, Ilyra tries the next best one.
- **Local models.** Run [Ollama](https://ollama.com), LM Studio, llama.cpp, Jan or vLLM and Ilyra finds it: open **Settings, AI models**, press Save on the Local row, and pick a model. No key, the conversation goes only to your own server, and it gets the same tools as the cloud models (minus web search and running code, which happen on the providers' side).
- **Auto routing.** Code, research, images and everyday questions each go to the model you choose under **Settings, Who handles what**, or to a sensible default.
- **Web search, page reading and code.** Models search the web with their providers' own tools, can open a specific page (never private or local addresses), and run Python in the provider's sandbox.
- **Images.** Attach or paste a picture, or capture your screen, and ask about it. ChatGPT and Gemini can make and edit images.
- **Live previews.** A web page, app or game the model writes opens as a working preview beside the chat.
- **Files.** Share a folder and Ilyra can read and edit files in it. Every change is shown in full and approved first, and old copies are kept for two weeks. Files that usually hold secrets are always off limits.
- **PDFs.** Ask for a report, letter or résumé as a PDF.
- **Memory and briefs.** A short note about you, and a page about each project or part of your life, read at the start of every chat. Each save to memory is approved unless you turn that off.
- **Scheduled tasks.** "Remind me at 3:30", or "every weekday at 8, brief me on the news". Ilyra must be running; background mode keeps it in the tray.
- **Connectors.** Add any remote MCP server (like Higgsfield) and your models can use its tools, with your approval.
- **Voice.** Dictate, or switch on talk mode and speak back and forth. Speech is turned into text on your computer; replies are read aloud by OpenAI's voices with a ChatGPT key, or the Windows voice without one.
- **Slash commands.** Type `/` for a menu: `/compact`, `/clear`, `/context`, `/usage`, `/model`, `/think`, `/web`, `/code`, `/memory`, `/remember`, `/forget`, `/copy`, `/export`, `/retry` and `/help`. They run in Ilyra and are never sent to a model.
- **Usage.** Tokens are counted per model, per day and per chat, on your computer.

## Run it

```bash
npm install
npm start
```

`npm test` runs the test suite. `npm run preview` serves the interface in a browser (no models) for working on the page.

## Build the Windows app

```bash
npm run dist
```

Produces `release/Ilyra Setup <version>.exe` (installer) and `release/Ilyra-<version>-portable.exe`. Builds are unsigned, so SmartScreen warns and Smart App Control may block them until code signing is set up.

## Layout

| Path | What it is |
|---|---|
| `electron/main.js` | The window, tray and every request the page makes; model fallback |
| `electron/preload.js` | The only bridge between the page and the main process |
| `electron/providers.js` | Claude, OpenAI, Gemini and Meta through their official SDKs; model ranking; error messages |
| `electron/local.js` | Local models: finding the server, Ollama's API and OpenAI-compatible ones |
| `electron/agent.js` | One reply: the system prompt and the tool-calling loop |
| `electron/tools.js` | The tools models can call: files, chats, memory, clipboard, tasks, images, PDFs, web pages |
| `electron/mcp.js` | Connectors (remote MCP servers) |
| `electron/keystore.js`, `store.js` | Encrypted keys, chats, memory, briefs, tasks and settings |
| `electron/voice.js` | On-device speech to text |
| `web/` | The interface: `index.html`, `styles.css`, `app.js`, the orb (`orb.js`, `miniorb.js`) and voice detection (`vad.js`) |
| `scripts/` | Renders the app icon (`npm run icon`) |
| `test/` | Tests, run with `npm test` |

## License

[MIT](LICENSE)
