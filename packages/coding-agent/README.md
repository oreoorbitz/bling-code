# Ling Code

Ling Code is a full fork of [Pi](https://github.com/earendil-works/pi), focused on Ling 3.1 Flash with an explicitly selectable Ling 3.0 profile. It retains Pi's CLI/TUI, tools, sessions, compaction, extensions, skills, prompt templates, and themes.

The endpoint is always explicit: Ling Code does not select a hosted provider, store API keys in `models.json`, or silently substitute another Ling version. Both profiles default to a 262,144-token served context and 32,768 output tokens; override these only to match the actual server.

Use Ling Code [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md).

## Getting started

Install Node.js 22.19 or newer. From the source checkout:

```bash
npm install --ignore-scripts
npm run build
```

Configure a local vLLM or SGLang endpoint:

```bash
export LING_API_KEY=local-development-key
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url http://localhost:30000/v1 \
  --dialect chat-template
```

Use `--dialect ling` for a first-party Ant Ling-compatible endpoint or `--dialect openrouter` for OpenRouter. Use `--profile 3.0` and the server's exact `--model-id` to select Ling 3.0 explicitly. Run `ling configure --help` for context, output, credential-variable, and replacement options.

Start in the directory where you want Ling Code to work:

```bash
cd /path/to/project
node /path/to/ling-code/packages/coding-agent/dist/bundle/cli.js
```

See the [model configuration documentation](docs/models.md) for advanced endpoint settings and the [documentation index](docs/index.md) for inherited Pi functionality.

## Share your OSS coding agent sessions

If you use Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Pi sessions
- Published Pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
