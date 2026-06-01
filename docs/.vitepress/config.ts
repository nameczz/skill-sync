import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Skill Sync",
  description: "Local-first Git sync for AI agent skills.",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Configuration", link: "/guide/configuration" },
      { text: "API", link: "/reference/api" }
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "Sync Model", link: "/guide/sync-model" }
        ]
      },
      {
        text: "Reference",
        items: [{ text: "API", link: "/reference/api" }]
      }
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/nameczz/skill-sync" }]
  }
});
