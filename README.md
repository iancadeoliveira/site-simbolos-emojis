# Unicode Explorer

Unicode Explorer is a searchable catalog of Unicode characters. The site does not hardcode Unicode blocks, ranges, counts, or characters in the frontend. It reads generated JSON files that are built from the official Unicode data files kept in this project.

## Project Structure

```text
.
├── index.html
├── style.css
├── app.js
├── package.json
├── data/
│   ├── source/
│   │   ├── UnicodeData.txt
│   │   └── Blockscomplet.txt
│   └── generated/
│       ├── unicode-characters.json
│       ├── unicode-blocks.json
│       └── unicode-summary.json
├── scripts/
│   └── build-unicode-data.js
└── README.md
```

## Official Source Data

The official Unicode source files are:

- `data/source/UnicodeData.txt`
- `data/source/Blockscomplet.txt`

Do not edit these files manually. Replace them only when updating to a newer Unicode release.

## Generated Data

The generated files used by the website are:

- `data/generated/unicode-characters.json`
- `data/generated/unicode-blocks.json`
- `data/generated/unicode-summary.json`

These files can be recreated at any time from the official source files.

## Requirements

Install Node.js before running the data build script. No npm packages are required.

## Rebuild The Unicode JSON Files

From this project folder, run:

```bash
npm run build:data
```

Or run the script directly:

```bash
node scripts/build-unicode-data.js
```

The script expands `<..., First>` / `<..., Last>` ranges from `UnicodeData.txt`, skips surrogate code points, assigns each character to a block from `Blockscomplet.txt`, and writes the JSON files in `data/generated/`.

## Open The Site

Open this folder with VS Code and use Live Server on `index.html`. The page uses `fetch()`, so it should be served over HTTP instead of opened directly from the filesystem.

## Update Unicode

1. Replace `data/source/UnicodeData.txt`.
2. Replace `data/source/Blockscomplet.txt`.
3. Run `npm run build:data`.
4. Refresh the Live Server page.

## Configuration

The large-block threshold is in `scripts/build-unicode-data.js`:

```js
const LARGE_BLOCK_THRESHOLD = 1000;
```

Blocks with more than this number of characters are kept in the generated data with `status: "large"` but hidden from the current interface.

The initial number of characters shown per visible block is in `app.js`:

```js
const INITIAL_ITEMS_PER_BLOCK = 100;
```

Large and empty blocks are not deleted. They remain in `unicode-blocks.json`; they are only excluded from the visible interface for now.
