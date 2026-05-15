# Audio API

Audio analysis service.

## Docs

- [`docs/user-guide.md`](docs/user-guide.md) — for API consumers
- [`docs/technical-guide.md`](docs/technical-guide.md) — for operators and contributors
- [`docs/spec.md`](docs/spec.md) — original design spec
- [`docs/plans/`](docs/plans/) — implementation plans
- [`docs/diagrams/`](docs/diagrams/) — architecture and job lifecycle (open in [excalidraw.com](https://excalidraw.com))

## Quickstart

    cp .env.example .env
    make up
    make migrate
    make seed
    make smoke
