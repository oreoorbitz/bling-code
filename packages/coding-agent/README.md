# Bling Code

Bling Code is a full fork of [Pi](https://github.com/earendil-works/pi), focused on Ling 3.1 Flash with explicitly selectable Ling 3.0 and Ling 3.0 VL profiles. It retains Pi's CLI/TUI, tools, sessions, compaction, extensions, skills, prompt templates, and themes.

Ling is served through OpenRouter by default, using the built-in `openrouter` provider and its model catalog. A self-hosted OpenAI-compatible endpoint remains available with `--base-url`. Bling Code does not store API keys in `models.json` or silently substitute another model or Ling version.

Use Bling Code [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md).

## Getting started

Install Node.js 22.19 or newer. From the source checkout:

```bash
npm install --ignore-scripts
npm run build
```

Select Ling 3.1 Flash on OpenRouter with its recommended sampling:

```bash
export OPENROUTER_API_KEY='your-openrouter-key'
node packages/coding-agent/dist/bundle/cli.js configure
```

Use `--profile 3.0` or `--profile 3.0-vl` for Ling 3.0 Flash or its vision variant. For a self-hosted vLLM or SGLang server, add `--base-url http://localhost:30000/v1`; run `bling configure --help` for the endpoint, dialect, context, output, and credential-variable options.

Start in the directory where you want Bling Code to work:

```bash
cd /path/to/project
node /path/to/bling-code/packages/coding-agent/dist/bundle/cli.js
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
