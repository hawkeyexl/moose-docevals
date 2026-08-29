// @ts-check
/**
 * ESLint flat config.
 *
 * Type-aware linting is the point. `tsconfig.json` is already `strict` with
 * `noUncheckedIndexedAccess`, so a syntax-only rule set would add almost
 * nothing. What `strictTypeChecked` catches that `tsc` does not is an
 * *inferred* `any` crossing a boundary — a commander callback parameter, a
 * `JSON.parse`, an untyped tool payload — which never appears as the word
 * `any` in the source and so cannot be grepped for. It needs type information,
 * supplied here by `projectService`.
 *
 * When a rule is genuinely wrong for this codebase, turn it off here with the
 * reason, rather than scattering inline disables.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * `strictTypeChecked` rules retuned for this codebase rather than silenced at
 * their call sites. Applied to `src` and `test` alike.
 */
const houseRules = {
  // moose-docevals is a reporting CLI: "3 evals failed", "exit code 2",
  // "confidence 0.87", "line 12". Interpolating a `number` is its main idiom
  // and the conversion is total.
  //
  // Every other flag is restated at `strictTypeChecked`'s value rather than
  // omitted: ESLint merges rule options with the *rule's own* defaults, not
  // with the config being extended, and those defaults allow `any`, `boolean`,
  // nullish and RegExp. Passing `{ allowNumber: true }` alone would silently
  // relax four more flags — including the `string | undefined` interpolation
  // that is worth seeing.
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    {
      allowAny: false,
      allowBoolean: false,
      allowNever: false,
      allowNullish: false,
      allowNumber: true,
      allowRegExp: false,
    },
  ],
  // Grader implementations satisfy an interface whose `grade` returns a
  // Promise. Several graders are wholly synchronous, and `async` is the
  // ergonomic way to meet that signature — the alternative is
  // `return Promise.resolve(...)` at every one, which is noise, not clarity.
  // The rule has no exception for implementing an async contract.
  "@typescript-eslint/require-await": "off",
  // A real backlog, deliberately a warning rather than an error.
  //
  // `tsconfig` sets `noUncheckedIndexedAccess`, so `arr[0]` is `T | undefined`
  // and this codebase reaches for `!` after a length check — 42 times. Every
  // one is probably sound and none is *proven* sound, which is the rule's
  // point, and CLAUDE.md already asks for guards instead. Clearing them is a
  // real change with real regression risk, and silencing the rule would hide a
  // finding the house style agrees with. A warning keeps it visible on every
  // run and out of the build's way until the backlog is worked.
  "@typescript-eslint/no-non-null-assertion": "warn",
  // `_name` already means "deliberately unused" here, and `tsc`'s
  // `noUnusedLocals`/`noUnusedParameters` honour the same convention. Matching
  // it keeps one rule rather than two that disagree.
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      ".tmp/",
      // A separate package with its own lockfile and toolchain, not covered by
      // this repo's tsconfig — so it must not be covered by its lint either.
      "docs/",
      ".doc-detective/",
      ".ci-config-check/",
    ],
  },

  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: houseRules,
  },

  {
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...houseRules,
      // Four of the `no-unsafe-*` family, off for tests only.
      //
      // The integration suite parses the CLI's own `--format json` output and
      // asserts on it — which is how it checks that output at all. `JSON.parse`
      // returns `any` by contract, so every one of those correct assertions
      // trips this family. Typing each payload would restate `src/`'s own types
      // inside the tests, which is how a test stops proving anything about the
      // shipped type.
      //
      // `src/` keeps all of them, which is where they earn their keep: a stray
      // `any` in the product is a bug waiting to ship; in a test it is an
      // assertion that fails loudly the moment the shape changes.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  {
    // Plain JavaScript, and *not* in tsconfig's `include` (`["src", "test"]`),
    // so type-aware linting has no program to work from — `disableTypeChecked`
    // turns those rules off rather than letting them fail on every file.
    files: ["scripts/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
);
