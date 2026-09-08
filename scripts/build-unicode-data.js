const fs = require("node:fs");
const path = require("node:path");

const LARGE_BLOCK_THRESHOLD = 1000;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(PROJECT_ROOT, "data", "source");
const GENERATED_DIR = path.join(PROJECT_ROOT, "data", "generated");

const UNICODE_DATA_FILE = path.join(SOURCE_DIR, "UnicodeData.txt");
const BLOCKS_FILE = path.join(SOURCE_DIR, "Blockscomplet.txt");

const CHARACTERS_FILE = path.join(GENERATED_DIR, "unicode-characters.json");
const BLOCKS_JSON_FILE = path.join(GENERATED_DIR, "unicode-blocks.json");
const SUMMARY_FILE = path.join(GENERATED_DIR, "unicode-summary.json");

const UNICODE_MIN = 0x0000;
const UNICODE_MAX = 0x10ffff;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;

function readRequiredFile(filePath, label) {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (error) {
        throw new Error(`Could not read ${label} at ${filePath}: ${error.message}`);
    }
}

function parseCodePoint(hex, sourceLabel) {
    const value = Number.parseInt(hex, 16);

    if (!Number.isInteger(value) || value < UNICODE_MIN || value > UNICODE_MAX) {
        throw new Error(`${sourceLabel} has invalid code point: ${hex}`);
    }

    return value;
}

function isSurrogate(codePoint) {
    return codePoint >= SURROGATE_START && codePoint <= SURROGATE_END;
}

function formatHex(codePoint) {
    return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

function formatCodePoint(codePoint) {
    return `U+${formatHex(codePoint)}`;
}

function normalizeRangeName(name) {
    return name.replace(/^</, "").replace(/,\s*First>$/, "").replace(/,\s*Last>$/, "");
}

function resolveCharacterName(fields, codePoint, rangeName) {
    const unicodeName = fields[1];
    const unicode1Name = fields[10];

    if (rangeName) {
        return `${rangeName} ${formatCodePoint(codePoint)}`;
    }

    if (unicodeName === "<control>" && unicode1Name) {
        return unicode1Name;
    }

    return unicodeName;
}

function parseBlocks(text) {
    const blocks = [];
    const lines = text.split(/\r?\n/);
    let unicodeVersion = null;

    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index];
        const versionMatch = rawLine.match(/^#\s*Blocks-([0-9.]+)\.txt/);

        if (versionMatch) {
            unicodeVersion = versionMatch[1];
        }

        const line = rawLine.split("#")[0].trim();

        if (!line) {
            continue;
        }

        const match = line.match(/^([0-9A-Fa-f]+)(?:\.\.([0-9A-Fa-f]+))?\s*;\s*(.+)$/);

        if (!match) {
            throw new Error(`Blockscomplet.txt line ${index + 1} could not be parsed: ${rawLine}`);
        }

        const startCodePoint = parseCodePoint(match[1], `Blockscomplet.txt line ${index + 1}`);
        const endCodePoint = parseCodePoint(match[2] || match[1], `Blockscomplet.txt line ${index + 1}`);

        if (endCodePoint < startCodePoint) {
            throw new Error(`Blockscomplet.txt line ${index + 1} has an inverted range: ${rawLine}`);
        }

        blocks.push({
            name: match[3].trim(),
            startValue: startCodePoint,
            endValue: endCodePoint,
            startCodePoint: formatCodePoint(startCodePoint),
            endCodePoint: formatCodePoint(endCodePoint),
            characterCount: 0,
            status: "empty",
            isVisible: false,
        });
    }

    return { blocks, unicodeVersion };
}

function createBlockResolver(blocks) {
    let blockIndex = 0;

    return function resolveBlock(codePoint) {
        while (blockIndex < blocks.length && codePoint > blocks[blockIndex].endValue) {
            blockIndex++;
        }

        const block = blocks[blockIndex];

        if (block && codePoint >= block.startValue && codePoint <= block.endValue) {
            return block;
        }

        return null;
    };
}

function appendCharacter(characters, blockCounts, noBlockCounter, fields, codePoint, rangeName) {
    if (isSurrogate(codePoint)) {
        return false;
    }

    const block = blockCounts.resolveBlock(codePoint);
    const blockName = block ? block.name : "No_Block";

    if (block) {
        block.characterCount++;
    } else {
        noBlockCounter.count++;
    }

    characters.push({
        codePoint: formatCodePoint(codePoint),
        codePointHex: formatHex(codePoint),
        codePointDecimal: codePoint,
        character: String.fromCodePoint(codePoint),
        name: resolveCharacterName(fields, codePoint, rangeName),
        generalCategory: fields[2],
        block: blockName,
    });

    return true;
}

function parseUnicodeData(text, blocks) {
    const characters = [];
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    const blockResolver = createBlockResolver(blocks);
    const noBlockCounter = { count: 0 };
    let pendingFirst = null;
    let skippedSurrogateCount = 0;

    const blockCounts = {
        resolveBlock: blockResolver,
    };

    for (let index = 0; index < lines.length; index++) {
        const rawLine = lines[index];
        const fields = rawLine.split(";");

        if (fields.length < 15) {
            throw new Error(`UnicodeData.txt line ${index + 1} has ${fields.length} fields instead of 15`);
        }

        const codePoint = parseCodePoint(fields[0], `UnicodeData.txt line ${index + 1}`);
        const name = fields[1];

        if (name.endsWith(", First>")) {
            if (pendingFirst) {
                throw new Error(
                    `UnicodeData.txt line ${index + 1} starts a range before closing ${pendingFirst.fields[1]}`
                );
            }

            pendingFirst = {
                fields,
                codePoint,
                lineNumber: index + 1,
                rangeName: normalizeRangeName(name),
            };
            continue;
        }

        if (name.endsWith(", Last>")) {
            if (!pendingFirst) {
                throw new Error(`UnicodeData.txt line ${index + 1} has Last without a matching First`);
            }

            if (codePoint < pendingFirst.codePoint) {
                throw new Error(`UnicodeData.txt line ${index + 1} closes an inverted range`);
            }

            const lastRangeName = normalizeRangeName(name);

            if (lastRangeName !== pendingFirst.rangeName) {
                throw new Error(
                    `UnicodeData.txt range mismatch between ${pendingFirst.fields[1]} and ${name}`
                );
            }

            for (let rangeCodePoint = pendingFirst.codePoint; rangeCodePoint <= codePoint; rangeCodePoint++) {
                if (isSurrogate(rangeCodePoint)) {
                    skippedSurrogateCount++;
                    continue;
                }

                appendCharacter(
                    characters,
                    blockCounts,
                    noBlockCounter,
                    pendingFirst.fields,
                    rangeCodePoint,
                    pendingFirst.rangeName
                );
            }

            pendingFirst = null;
            continue;
        }

        if (isSurrogate(codePoint)) {
            skippedSurrogateCount++;
            continue;
        }

        appendCharacter(characters, blockCounts, noBlockCounter, fields, codePoint, null);
    }

    if (pendingFirst) {
        throw new Error(
            `UnicodeData.txt range starting at line ${pendingFirst.lineNumber} was not closed: ${pendingFirst.fields[1]}`
        );
    }

    return {
        characters,
        totalSourceLines: lines.length,
        noBlockCharacterCount: noBlockCounter.count,
        skippedSurrogateCount,
    };
}

function finalizeBlocks(blocks) {
    return blocks.map((block) => {
        let status = "active";
        let isVisible = true;

        if (block.characterCount === 0) {
            status = "empty";
            isVisible = false;
        } else if (block.characterCount > LARGE_BLOCK_THRESHOLD) {
            status = "large";
            isVisible = false;
        }

        return {
            name: block.name,
            startCodePoint: block.startCodePoint,
            endCodePoint: block.endCodePoint,
            characterCount: block.characterCount,
            status,
            isVisible,
        };
    });
}

function writeJson(filePath, data, pretty = true) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, pretty ? 2 : 0), "utf8");
}

function build() {
    const blocksText = readRequiredFile(BLOCKS_FILE, "Blockscomplet.txt");
    const unicodeText = readRequiredFile(UNICODE_DATA_FILE, "UnicodeData.txt");
    const { blocks, unicodeVersion } = parseBlocks(blocksText);
    const unicodeData = parseUnicodeData(unicodeText, blocks);
    const finalizedBlocks = finalizeBlocks(blocks);

    const activeBlocks = finalizedBlocks.filter((block) => block.status === "active");
    const largeBlocks = finalizedBlocks.filter((block) => block.status === "large");
    const emptyBlocks = finalizedBlocks.filter((block) => block.status === "empty");

    const summary = {
        unicodeVersion,
        totalSourceLines: unicodeData.totalSourceLines,
        totalExpandedCharacters: unicodeData.characters.length,
        totalBlocks: finalizedBlocks.length,
        activeBlockCount: activeBlocks.length,
        largeBlockCount: largeBlocks.length,
        emptyBlockCount: emptyBlocks.length,
        noBlockCharacterCount: unicodeData.noBlockCharacterCount,
        activeCharacterCount: activeBlocks.reduce((total, block) => total + block.characterCount, 0),
        largeBlockCharacterCount: largeBlocks.reduce((total, block) => total + block.characterCount, 0),
        skippedSurrogateCount: unicodeData.skippedSurrogateCount,
        largeBlockThreshold: LARGE_BLOCK_THRESHOLD,
        generatedAt: new Date().toISOString(),
    };

    writeJson(CHARACTERS_FILE, unicodeData.characters, false);
    writeJson(BLOCKS_JSON_FILE, finalizedBlocks, true);
    writeJson(SUMMARY_FILE, summary, true);

    console.log(`Generated ${path.relative(PROJECT_ROOT, CHARACTERS_FILE)}`);
    console.log(`Generated ${path.relative(PROJECT_ROOT, BLOCKS_JSON_FILE)}`);
    console.log(`Generated ${path.relative(PROJECT_ROOT, SUMMARY_FILE)}`);
    console.log(`Processed ${summary.totalExpandedCharacters} characters across ${summary.totalBlocks} blocks`);
}

try {
    build();
} catch (error) {
    console.error(`Unicode data generation failed: ${error.message}`);
    process.exitCode = 1;
}
