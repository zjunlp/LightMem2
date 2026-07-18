 import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'LightMem2',
  description: 'An open plugin platform for long-running AI agents',
  base: '/LightMem2/',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: false,

  head: [
    ['link', { rel: 'icon', href: '/images/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#7C5CFF' }],
    ['meta', { property: 'og:title', content: 'LightMem2' }],
    ['meta', { property: 'og:description', content: 'An open plugin platform for long-running AI agents' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],

  themeConfig: {
    logo: { src: '/images/logo.svg', alt: 'LightMem2' },
    siteTitle: 'LightMem2',

    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started/what-is-lightmem2' },
      { text: 'Platform Concepts', link: '/platform-concepts/core-runtime' },
      { text: 'Plugin Catalog', link: '/plugin-catalog/overview' },
      { text: 'Hosts', link: '/hosts/compatibility' },
      { text: 'User Guide', link: '/user-guide/managing-plugins' },
      {
        text: 'More',
        items: [
          { text: 'Plugin Development', link: '/plugin-development/build-your-first-plugin' },
          { text: 'Host Adapter Development', link: '/host-adapter-development/adapter-architecture' },
          { text: 'Plugin Registry', link: '/plugin-registry/official-plugins' },
          { text: 'Development', link: '/development/repository-structure' },
          { text: 'Project', link: '/project/roadmap' },
          { text: 'GitHub', link: 'https://github.com/zjunlp/LightMem2' },
          { text: 'Paper', link: 'https://arxiv.org/abs/2606.17016' },
        ],
      },
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'What is LightMem2', link: '/getting-started/what-is-lightmem2' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Install LightMem2', link: '/getting-started/install-lightmem2' },
            { text: 'Install Your First Plugin', link: '/getting-started/install-first-plugin' },
          ],
        },
      ],
      '/platform-concepts/': [
        {
          text: 'Platform Concepts',
          items: [
            { text: 'Core Runtime', link: '/platform-concepts/core-runtime' },
            { text: 'Plugins', link: '/platform-concepts/plugins' },
            { text: 'Host Adapters', link: '/platform-concepts/host-adapters' },
            { text: 'Plugin Lifecycle', link: '/platform-concepts/plugin-lifecycle' },
            { text: 'Configuration Model', link: '/platform-concepts/configuration-model' },
            { text: 'Data and Permissions', link: '/platform-concepts/data-and-permissions' },
          ],
        },
      ],
      '/plugin-catalog/': [
        {
          text: 'Plugin Catalog',
          items: [
            { text: 'Overview', link: '/plugin-catalog/overview' },
          ],
        },
        {
          text: 'TokenPilot',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/plugin-catalog/tokenpilot/overview' },
            { text: 'Installation', link: '/plugin-catalog/tokenpilot/installation' },
            { text: 'Configuration', link: '/plugin-catalog/tokenpilot/configuration' },
            { text: 'Runtime Modes', link: '/plugin-catalog/tokenpilot/runtime-modes' },
            { text: 'Stable Prefix', link: '/plugin-catalog/tokenpilot/stable-prefix' },
            { text: 'Context Reduction', link: '/plugin-catalog/tokenpilot/context-reduction' },
            { text: 'Context Eviction', link: '/plugin-catalog/tokenpilot/context-eviction' },
            { text: 'Reports and Visuals', link: '/plugin-catalog/tokenpilot/reports-and-visuals' },
            { text: 'Benchmarks', link: '/plugin-catalog/tokenpilot/benchmarks' },
            { text: 'Troubleshooting', link: '/plugin-catalog/tokenpilot/troubleshooting' },
          ],
        },
      ],
      '/hosts/': [
        {
          text: 'Hosts',
          items: [
            { text: 'Compatibility', link: '/hosts/compatibility' },
            { text: 'OpenClaw', link: '/hosts/openclaw' },
            { text: 'Codex', link: '/hosts/codex' },
            { text: 'Claude Code', link: '/hosts/claude-code' },
          ],
        },
      ],
      '/user-guide/': [
        {
          text: 'User Guide',
          items: [
            { text: 'Managing Plugins', link: '/user-guide/managing-plugins' },
            { text: 'Enabling and Disabling Plugins', link: '/user-guide/enabling-disabling' },
            { text: 'Plugin Configuration', link: '/user-guide/plugin-configuration' },
            { text: 'Sessions', link: '/user-guide/sessions' },
            { text: 'CLI Reference', link: '/user-guide/cli-reference' },
            { text: 'Visual Inspector', link: '/user-guide/visual-inspector' },
            { text: 'Logs and Diagnostics', link: '/user-guide/logs-and-diagnostics' },
            { text: 'Uninstall and Rollback', link: '/user-guide/uninstall-and-rollback' },
          ],
        },
      ],

      '/plugin-development/': [
        {
          text: 'Plugin Development',
          items: [
            { text: 'Build Your First Plugin', link: '/plugin-development/build-your-first-plugin' },
            { text: 'Plugin Directory Structure', link: '/plugin-development/directory-structure' },
            { text: 'Plugin Manifest', link: '/plugin-development/manifest' },
            { text: 'Runtime API', link: '/plugin-development/runtime-api' },
            { text: 'Lifecycle Hooks', link: '/plugin-development/lifecycle-hooks' },
            { text: 'Host-independent Design', link: '/plugin-development/host-independent-design' },
            { text: 'Configuration Schema', link: '/plugin-development/configuration-schema' },
            { text: 'Metrics and Observability', link: '/plugin-development/metrics' },
            { text: 'Testing Plugins', link: '/plugin-development/testing' },
            { text: 'Packaging Plugins', link: '/plugin-development/packaging' },
            { text: 'Publishing Plugins', link: '/plugin-development/publishing' },
          ],
        },
      ],
      '/host-adapter-development/': [
        {
          text: 'Host Adapter Development',
          items: [
            { text: 'Adapter Architecture', link: '/host-adapter-development/adapter-architecture' },
            { text: 'Adding a New Host', link: '/host-adapter-development/adding-new-host' },
            { text: 'Configuration Integration', link: '/host-adapter-development/configuration-integration' },
            { text: 'Hook and Proxy Integration', link: '/host-adapter-development/hook-proxy-integration' },
            { text: 'Adapter Testing', link: '/host-adapter-development/adapter-testing' },
          ],
        },
      ],
      '/plugin-registry/': [
        {
          text: 'Plugin Registry',
          items: [
            { text: 'Official Plugins', link: '/plugin-registry/official-plugins' },
            { text: 'Community Plugins', link: '/plugin-registry/community-plugins' },
            { text: 'Submission Requirements', link: '/plugin-registry/submission-requirements' },
            { text: 'Compatibility Policy', link: '/plugin-registry/compatibility-policy' },
            { text: 'Security Review', link: '/plugin-registry/security-review' },
          ],
        },
      ],
      '/development/': [
        {
          text: 'Development',
          items: [
            { text: 'Repository Structure', link: '/development/repository-structure' },
            { text: 'Local Development', link: '/development/local-development' },
            { text: 'Build and Test', link: '/development/build-and-test' },
            { text: 'Contributing', link: '/development/contributing' },
          ],
        },
      ],
      '/project/': [
        {
          text: 'Project',
          items: [
            { text: 'Roadmap', link: '/project/roadmap' },
            { text: 'Changelog', link: '/project/changelog' },
            { text: 'Security', link: '/project/security' },
            { text: 'Citation', link: '/project/citation' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/zjunlp/LightMem2' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 ZJUNLP',
    },

    editLink: {
      pattern: 'https://github.com/zjunlp/LightMem2/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },
  },
})
