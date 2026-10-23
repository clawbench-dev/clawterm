# Thin wrapper over build.sh so `make` does the obvious thing.
.PHONY: build android release test lint dev clean

build:
	./build.sh

android:
	./build.sh --android

release:
	./build.sh --android --release

test:
	go test ./...
	npx vitest run

lint:
	go vet ./...
	npx vue-tsc --noEmit -p web/tsconfig.json

dev:
	npm run dev

clean:
	rm -rf .clawterm-web internal/frontend/dist android/app/build android/build
