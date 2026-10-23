# Thin wrapper over build.sh so `make` does the obvious thing.
.PHONY: apk release test typecheck clean

apk:
	./build.sh

release:
	./build.sh --release

test:
	npx vitest run
	cd android && ./gradlew testDebugUnitTest

typecheck:
	npx vue-tsc --noEmit -p web/tsconfig.json

clean:
	rm -rf .clawterm-web android/app/src/main/assets/web android/app/build android/build
