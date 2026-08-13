import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Section order and labels are fixed by the CUJ-first IA — see
// content-strategy/information-architecture/proposed-ia.md. Do not reorder or
// rename sections here without updating that file; the tree is the proposal,
// this config is its implementation.
export default defineConfig({
  site: "https://hawkeyexl.github.io",
  base: "/moose-docevals",
  integrations: [
    starlight({
      title: "moose-docevals",
      description:
        "Deterministic and LLM-as-judge evals for documentation pages, driven by frontmatter.",
      sidebar: [
        {
          label: "Get started",
          items: [{ autogenerate: { directory: "get-started" } }],
        },
        {
          label: "Write evals",
          items: [{ autogenerate: { directory: "evals" } }],
        },
        {
          label: "Adopt at scale",
          items: [{ autogenerate: { directory: "adopt" } }],
        },
        {
          label: "Run it in CI",
          items: [{ autogenerate: { directory: "ci" } }],
        },
        {
          label: "Trust the judge",
          items: [{ autogenerate: { directory: "judge" } }],
        },
        {
          label: "Fix a failing eval",
          items: [{ autogenerate: { directory: "fix" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
