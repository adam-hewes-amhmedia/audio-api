.PHONY: up down logs migrate seed smoke test build clean

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f

migrate:
	docker compose -f infra/docker-compose.yml run --rm migrate

seed:
	./scripts/seed-token.sh

smoke:
	pnpm smoke

test:
	pnpm -r test

build:
	pnpm -r build

clean:
	docker compose -f infra/docker-compose.yml down -v
	rm -rf node_modules services/*/node_modules packages/*/node_modules
