# Bundled Excalidraw libraries

Chat ships these shape libraries so the diagram editor is useful the moment it
opens, with no network: the target deployments block
`libraries.excalidraw.com` outright, and the renderer's CSP has no `https:` in
`connect-src` by design.

Every file here is a verbatim copy from the official
[excalidraw/excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries)
repository, fetched from `raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/<source>`
on 2026-09-10. That repository is licensed **MIT** (`LICENSE`, "Copyright (c)
2020 Excalidraw"), which is the licence these `.excalidrawlib` files are
distributed under; the individual entries in `libraries.json` carry no separate
licence field. Only vendor-neutral, non-trademarked sets were picked — no AWS /
Azure / Google / Kubernetes logo packs, whose drawings are MIT but whose marks
are not ours to redistribute.

Refresh instructions: download the same `source` path again and replace the
file. Nothing here is generated, and nothing here is loaded from the network at
runtime.

| File | Library | Author | Source | Updated | Size |
|---|---|---|---|---|---|
| `software-architecture.excalidrawlib` | Software Architecture — microservice, database, cache, event bus, documents, browser, mobile | [Youri Tjang](https://github.com/youritjang) | `youritjang/software-architecture.excalidrawlib` | 2020-12-30 | 44 KB |
| `lo-fi-wireframing-kit.excalidrawlib` | Lo-Fi Wireframing Kit — UX/UI wireframe components | [Aleksandra Lazovic](https://spfr.co) | `spfr/lo-fi-wireframing-kit.excalidrawlib` | 2021-02-10 | 249 KB |
| `uml-er-shapes.excalidrawlib` | Shapes for UML & ER Diagrams — data models and class/entity shapes | [BjoernKW](https://github.com/BjoernKW) | `BjoernKW/UML-ER-library.excalidrawlib` | 2021-08-12 | 119 KB |
| `flow-chart-symbols.excalidrawlib` | Flow Chart Symbols — start/end, process, decision, connectors, annotations | [Fin](https://github.com/finfin) | `finfin/flow-chart-symbols.excalidrawlib` | 2024-10-11 | 56 KB |
| `sticky-notes.excalidrawlib` | Sticky Notes — post-its in every colour, for design-thinking sessions | [ferminrp](https://github.com/ferminrp) | `ferminrp/post-it.excalidrawlib` | 2021-06-20 | 33 KB |

Total: 501 KB, 79 items, no embedded raster images (`files` is empty in every
file, so nothing here inflates a scene you send).

The editor itself is [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw)
0.18.1, also MIT (Copyright (c) 2020 Excalidraw), including the bundled fonts
(Excalifont, Virgil, Nunito, Lilita One, Comic Shanns, Cascadia Code, Liberation
Sans, Xiaolai) that `scripts/sync-excalidraw-assets.mjs` copies into the
renderer build — see that package's `LICENSE` for the font licences it carries.
