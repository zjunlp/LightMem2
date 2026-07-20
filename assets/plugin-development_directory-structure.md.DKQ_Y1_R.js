import{_ as s,o as n,c as e,a2 as t}from"./chunks/framework.D36jym0Z.js";const m=JSON.parse('{"title":"Plugin Directory Structure","description":"","frontmatter":{},"headers":[],"relativePath":"plugin-development/directory-structure.md","filePath":"plugin-development/directory-structure.md","lastUpdated":1784542960000}'),p={name:"plugin-development/directory-structure.md"};function r(c,a,i,l,o,d){return n(),e("div",null,[...a[0]||(a[0]=[t(`<h1 id="plugin-directory-structure" tabindex="-1">Plugin Directory Structure <a class="header-anchor" href="#plugin-directory-structure" aria-label="Permalink to &quot;Plugin Directory Structure&quot;">​</a></h1><div class="danger custom-block"><p class="custom-block-title">DANGER</p><p><code>components/tokenpilot/</code> README</p></div><h2 id="" tabindex="-1"><a class="header-anchor" href="#" aria-label="Permalink to &quot;&quot;">​</a></h2><div class="language-text vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">text</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>components/tokenpilot/</span></span>
<span class="line"><span> adapters/               # Host-specific integration</span></span>
<span class="line"><span>    openclaw/</span></span>
<span class="line"><span>    codex/</span></span>
<span class="line"><span>    claude-code/</span></span>
<span class="line"><span> products/</span></span>
<span class="line"><span>    cli/                # Shared CLI</span></span>
<span class="line"><span>    mcp/                # Shared MCP server</span></span>
<span class="line"><span> packages/</span></span>
<span class="line"><span>     host-adapter/       # Shared adapter contracts</span></span>
<span class="line"><span>     runtime-core/       # Runtime engine</span></span>
<span class="line"><span>     kernel/             # Shared types and interfaces</span></span>
<span class="line"><span>     layers/</span></span>
<span class="line"><span>         history/</span></span>
<span class="line"><span>         decision/</span></span>
<span class="line"><span>         memory/         # Experimental</span></span></code></pre></div><p>Plugin Directory Structure</p>`,5)])])}const h=s(p,[["render",r]]);export{m as __pageData,h as default};
