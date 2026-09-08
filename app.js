const INITIAL_ITEMS_PER_BLOCK = 100;
const INITIAL_SECTIONS_TO_RENDER = 3;
const RENDER_BATCH_SIZE = 50;
const OBSERVER_ROOT_MARGIN = "900px 0px";

const DATA_FILES = {
    characters: "data/generated/unicode-characters.json",
    blocks: "data/generated/unicode-blocks.json",
    summary: "data/generated/unicode-summary.json",
};

const searchInput = document.getElementById("search");
const summaryElement = document.getElementById("summary");
const errorElement = document.getElementById("error");
const blocksContainer = document.getElementById("blocks");
const blockNav = document.getElementById("blockNav");

const expandedBlocks = new Set();
const sectionStates = new Map();
const characterByCodePoint = new Map();

let allCharacters = [];
let activeBlocks = [];
let charactersByBlock = new Map();
let activeObserver = null;
let renderGeneration = 0;
let searchFrame = 0;

window.unicodeExplorerMetrics = {
    dataLoadMs: 0,
    processAndGroupMs: 0,
    shellRenderMs: 0,
    lastSearchMs: 0,
    lastSectionRender: null,
    dom: null,
    getDomSnapshot,
};

async function loadJson(filePath) {
    let response;

    try {
        response = await fetch(filePath);
    } catch (error) {
        const protocol = window.location.protocol;
        const hint = protocol === "file:"
            ? " Open the project with VS Code Live Server or another local HTTP server; direct file:// opening blocks JSON fetches."
            : "";

        throw new Error(`Could not fetch ${filePath}.${hint}`);
    }

    if (!response.ok) {
        throw new Error(`Could not load ${filePath}`);
    }

    try {
        return await response.json();
    } catch (error) {
        throw new Error(`Could not parse ${filePath}: ${error.message}`);
    }
}

function assertGeneratedData(characters, blocks) {
    if (!Array.isArray(characters) || characters.length === 0) {
        throw new Error(`${DATA_FILES.characters} is empty or invalid`);
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
        throw new Error(`${DATA_FILES.blocks} is empty or invalid`);
    }
}

function sortVisibleBlocks(blocks) {
    return blocks
        .filter((block) => block.status === "active" && block.isVisible)
        .sort((first, second) => {
            const countDifference = second.characterCount - first.characterCount;
            return countDifference || first.name.localeCompare(second.name);
        });
}

function normalizeSearchValue(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeCharacterForSearch(character) {
    const codePoint = character.codePoint.toLowerCase();
    const codePointHex = character.codePointHex.toLowerCase();
    const name = character.name.toLowerCase();
    const block = character.block.toLowerCase();

    character.searchText = `${character.character} ${codePoint} ${codePointHex} ${name} ${block}`;
    character.blockSearchText = block;
    characterByCodePoint.set(character.codePoint, character);

    return character;
}

function groupCharactersByBlock(characters, blocks) {
    const visibleBlockNames = new Set(blocks.map((block) => block.name));
    const groups = new Map(blocks.map((block) => [block.name, []]));

    for (const character of characters) {
        if (!visibleBlockNames.has(character.block)) {
            continue;
        }

        groups.get(character.block).push(normalizeCharacterForSearch(character));
    }

    return groups;
}

function getSearchTerm() {
    return normalizeSearchValue(searchInput.value);
}

function characterMatchesSearch(character, searchTerm) {
    if (!searchTerm) {
        return true;
    }

    const normalizedCode = searchTerm.replace(/^u\+/, "");
    return character.searchText.includes(searchTerm) || character.codePointHex.toLowerCase().includes(normalizedCode);
}

function getCharactersForBlock(block, searchTerm) {
    const characters = charactersByBlock.get(block.name) || [];

    if (!searchTerm) {
        return characters;
    }

    if (block.name.toLowerCase().includes(searchTerm)) {
        return characters;
    }

    return characters.filter((character) => characterMatchesSearch(character, searchTerm));
}

function createElement(tagName, className, textContent) {
    const element = document.createElement(tagName);

    if (className) {
        element.className = className;
    }

    if (textContent !== undefined) {
        element.textContent = textContent;
    }

    return element;
}

function escapeSelector(value) {
    return CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

function getDomSnapshot(label) {
    return {
        label,
        elements: document.querySelectorAll("*").length,
        sections: document.querySelectorAll(".unicode-block").length,
        renderedSections: document.querySelectorAll(".unicode-block.is-rendered").length,
        cards: document.querySelectorAll(".symbol-card").length,
        toggles: document.querySelectorAll("[data-toggle-block]").length,
        navItems: document.querySelectorAll("[data-nav-block]").length,
    };
}

function recordDomSnapshot(label) {
    window.unicodeExplorerMetrics.dom = getDomSnapshot(label);
    console.info("[Unicode Explorer]", window.unicodeExplorerMetrics.dom);
}

function updateSummary(summary) {
    const firstBlock = activeBlocks[0];
    const parts = [
        `${summary.totalExpandedCharacters.toLocaleString()} characters processed`,
        `${summary.activeBlockCount.toLocaleString()} active blocks`,
        `${summary.largeBlockCount.toLocaleString()} large blocks hidden`,
    ];

    if (firstBlock) {
        parts.push(`First block: ${firstBlock.name} (${firstBlock.characterCount.toLocaleString()})`);
    }

    summaryElement.textContent = parts.join(" · ");
}

function createNavButton(block) {
    const button = createElement("button", "block-nav__item", block.name);

    button.type = "button";
    button.dataset.navBlock = block.name;
    button.title = `${block.name}: ${block.characterCount.toLocaleString()} characters`;

    return button;
}

function renderNavigation(blocks) {
    const fragment = document.createDocumentFragment();

    for (const block of blocks) {
        fragment.appendChild(createNavButton(block));
    }

    blockNav.replaceChildren(fragment);
}

function createCharacterCard(character) {
    const card = createElement("article", "symbol-card");
    card.dataset.codePoint = character.codePoint;

    const glyph = createElement("div", "symbol-card__glyph", character.character);
    const code = createElement("div", "symbol-card__code", character.codePoint);
    const name = createElement("div", "symbol-card__name", character.name);
    const copyButton = createElement("button", "symbol-card__copy", "Copy");

    copyButton.type = "button";
    copyButton.dataset.copyCodePoint = character.codePoint;
    copyButton.setAttribute("aria-label", `Copy ${character.codePoint}`);

    card.append(glyph, code, name, copyButton);
    return card;
}

function createToggleButton(blockName, visibleCount, isExpanded, isSearchMode) {
    const toggleButton = createElement(
        "button",
        "unicode-block__toggle",
        isExpanded
            ? "Show less"
            : `Show all ${visibleCount.toLocaleString()} ${isSearchMode ? "matches" : "characters"}`
    );

    toggleButton.type = "button";
    toggleButton.dataset.toggleBlock = blockName;
    toggleButton.dataset.expanded = String(isExpanded);

    return toggleButton;
}

function createBlockShell(block, characters, searchTerm) {
    const isExpanded = expandedBlocks.has(block.name);
    const section = createElement("section", "unicode-block unicode-section");
    const header = createElement("header", "unicode-block__header");
    const titleGroup = createElement("div", "unicode-block__title-group");
    const title = createElement("h2", "unicode-block__title", block.name);
    const count = createElement(
        "p",
        "unicode-block__count",
        `${characters.length.toLocaleString()} ${characters.length === 1 ? "character" : "characters"}`
    );
    const grid = createElement("div", "symbol-grid is-pending");
    const placeholder = createElement("div", "symbol-grid__placeholder", "Symbols will load as this section approaches the viewport.");

    section.id = `block-${block.name}`;
    section.dataset.blockName = block.name;
    grid.dataset.gridBlock = block.name;
    placeholder.dataset.placeholderBlock = block.name;

    titleGroup.append(title, count);
    header.append(titleGroup);

    if (characters.length > INITIAL_ITEMS_PER_BLOCK) {
        header.appendChild(createToggleButton(block.name, characters.length, isExpanded, Boolean(searchTerm)));
    }

    grid.appendChild(placeholder);
    section.append(header, grid);

    sectionStates.set(block.name, {
        block,
        section,
        grid,
        placeholder,
        characters,
        renderedCount: 0,
        targetCount: 0,
        renderToken: 0,
        isRendered: false,
        isRendering: false,
    });

    return section;
}

function getDesiredRenderCount(state) {
    if (expandedBlocks.has(state.block.name)) {
        return state.characters.length;
    }

    return Math.min(INITIAL_ITEMS_PER_BLOCK, state.characters.length);
}

function yieldToBrowser() {
    return new Promise((resolve) => {
        if ("requestIdleCallback" in window) {
            requestIdleCallback(() => resolve(), { timeout: 120 });
        } else {
            requestAnimationFrame(() => resolve());
        }
    });
}

async function renderSectionCards(blockName, options = {}) {
    const state = sectionStates.get(blockName);

    if (!state || state.characters.length === 0) {
        return;
    }

    const desiredCount = getDesiredRenderCount(state);

    if (!options.force && state.isRendered && state.renderedCount === desiredCount) {
        return;
    }

    const token = ++state.renderToken;
    const startTime = performance.now();
    state.isRendering = true;
    state.isRendered = false;
    state.targetCount = desiredCount;
    state.grid.classList.add("is-rendering");
    state.grid.classList.remove("is-pending");
    state.grid.replaceChildren();

    let index = 0;

    while (index < desiredCount) {
        if (token !== state.renderToken) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const end = Math.min(index + RENDER_BATCH_SIZE, desiredCount);

        for (; index < end; index++) {
            fragment.appendChild(createCharacterCard(state.characters[index]));
        }

        state.grid.appendChild(fragment);
        state.renderedCount = index;

        if (index < desiredCount) {
            await yieldToBrowser();
        }
    }

    state.isRendering = false;
    state.isRendered = true;
    state.section.classList.add("is-rendered");
    state.grid.classList.remove("is-rendering");

    window.unicodeExplorerMetrics.lastSectionRender = {
        block: blockName,
        cards: desiredCount,
        durationMs: Math.round((performance.now() - startTime) * 10) / 10,
        batchSize: RENDER_BATCH_SIZE,
    };
}

function disconnectObserver() {
    if (activeObserver) {
        activeObserver.disconnect();
    }
}

function observeSections() {
    disconnectObserver();

    activeObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }

            const blockName = entry.target.dataset.blockName;
            renderSectionCards(blockName);
            activeObserver.unobserve(entry.target);
        }
    }, {
        root: null,
        rootMargin: OBSERVER_ROOT_MARGIN,
        threshold: 0,
    });

    for (const state of sectionStates.values()) {
        activeObserver.observe(state.section);
    }
}

function renderInitialSections(blocks) {
    const initialBlocks = blocks.slice(0, INITIAL_SECTIONS_TO_RENDER);

    for (const block of initialBlocks) {
        renderSectionCards(block.name);
        if (activeObserver) {
            const state = sectionStates.get(block.name);
            activeObserver.unobserve(state.section);
        }
    }
}

function getBlocksForCurrentSearch() {
    const searchTerm = getSearchTerm();

    if (!searchTerm) {
        return activeBlocks.map((block) => ({
            block,
            characters: charactersByBlock.get(block.name) || [],
        }));
    }

    const results = [];

    for (const block of activeBlocks) {
        const characters = getCharactersForBlock(block, searchTerm);

        if (characters.length > 0) {
            results.push({ block, characters });
        }
    }

    return results;
}

function renderSectionShells() {
    const startTime = performance.now();
    const generation = ++renderGeneration;
    const searchTerm = getSearchTerm();
    const blockEntries = getBlocksForCurrentSearch();
    const fragment = document.createDocumentFragment();

    disconnectObserver();
    sectionStates.clear();

    for (const entry of blockEntries) {
        fragment.appendChild(createBlockShell(entry.block, entry.characters, searchTerm));
    }

    blocksContainer.replaceChildren(fragment);

    if (blockEntries.length === 0) {
        blocksContainer.appendChild(createElement("p", "empty-state", "No matching characters found."));
    } else {
        observeSections();
        renderInitialSections(blockEntries.map((entry) => entry.block));
    }

    window.unicodeExplorerMetrics.shellRenderMs = Math.round((performance.now() - startTime) * 10) / 10;
    recordDomSnapshot(`shells-generation-${generation}`);
}

function scheduleSearchRender() {
    if (searchFrame) {
        cancelAnimationFrame(searchFrame);
    }

    searchFrame = requestAnimationFrame(() => {
        const startTime = performance.now();
        expandedBlocks.clear();
        renderSectionShells();
        window.unicodeExplorerMetrics.lastSearchMs = Math.round((performance.now() - startTime) * 10) / 10;
        searchFrame = 0;
    });
}

async function navigateToBlock(blockName) {
    let state = sectionStates.get(blockName);

    if (!state && getSearchTerm()) {
        searchInput.value = "";
        expandedBlocks.clear();
        renderSectionShells();
        state = sectionStates.get(blockName);
    }

    if (!state) {
        return;
    }

    await renderSectionCards(blockName);

    if (activeObserver) {
        activeObserver.unobserve(state.section);
    }

    state.section.scrollIntoView({
        block: "start",
        behavior: "smooth",
    });
}

async function toggleBlock(button) {
    const blockName = button.dataset.toggleBlock;
    const state = sectionStates.get(blockName);

    if (!state) {
        return;
    }

    const wasExpanded = expandedBlocks.has(blockName);
    const scrollAnchor = wasExpanded
        ? {
            section: state.section,
            top: state.section.getBoundingClientRect().top,
        }
        : null;

    if (wasExpanded) {
        expandedBlocks.delete(blockName);
    } else {
        expandedBlocks.add(blockName);
    }

    const newButton = createToggleButton(
        blockName,
        state.characters.length,
        !wasExpanded,
        Boolean(getSearchTerm())
    );
    button.replaceWith(newButton);

    await renderSectionCards(blockName, { force: true });

    if (scrollAnchor) {
        const newTop = scrollAnchor.section.getBoundingClientRect().top;
        window.scrollBy(0, newTop - scrollAnchor.top);
    }

    recordDomSnapshot(wasExpanded ? "after-show-less" : "after-show-all");
}

function copyWithTextarea(value) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    if (!copied) {
        throw new Error("document.execCommand('copy') returned false");
    }
}

async function writeClipboardText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch (error) {
            console.warn("Clipboard API failed, trying textarea fallback.", error);
        }
    }

    copyWithTextarea(value);
}

async function copyCharacter(codePoint, button) {
    const character = characterByCodePoint.get(codePoint);

    if (!character) {
        return;
    }

    try {
        await writeClipboardText(character.character);

        const previousText = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
            button.textContent = previousText;
        }, 1200);
    } catch (error) {
        console.error(error);
        button.textContent = "Copy failed";
        window.setTimeout(() => {
            button.textContent = "Copy";
        }, 1200);
    }
}

function bindEvents() {
    searchInput.addEventListener("input", scheduleSearchRender);

    blockNav.addEventListener("click", (event) => {
        const navButton = event.target.closest("[data-nav-block]");

        if (!navButton) {
            return;
        }

        navigateToBlock(navButton.dataset.navBlock);
    });

    blocksContainer.addEventListener("click", (event) => {
        const toggleButton = event.target.closest("[data-toggle-block]");
        const copyButton = event.target.closest("[data-copy-code-point]");

        if (toggleButton) {
            toggleBlock(toggleButton);
            return;
        }

        if (copyButton) {
            copyCharacter(copyButton.dataset.copyCodePoint, copyButton);
        }
    });
}

function showError(error) {
    console.error(error);
    errorElement.hidden = false;
    errorElement.textContent = error.message;
    summaryElement.textContent = "Unicode data could not be loaded.";
}

async function initialize() {
    try {
        const loadStart = performance.now();
        const [characters, blocks, summary] = await Promise.all([
            loadJson(DATA_FILES.characters),
            loadJson(DATA_FILES.blocks),
            loadJson(DATA_FILES.summary),
        ]);
        window.unicodeExplorerMetrics.dataLoadMs = Math.round((performance.now() - loadStart) * 10) / 10;

        assertGeneratedData(characters, blocks);

        const processStart = performance.now();
        allCharacters = characters;
        activeBlocks = sortVisibleBlocks(blocks);
        charactersByBlock = groupCharactersByBlock(allCharacters, activeBlocks);
        window.unicodeExplorerMetrics.processAndGroupMs = Math.round((performance.now() - processStart) * 10) / 10;

        if (activeBlocks.length === 0) {
            throw new Error(`${DATA_FILES.blocks} does not contain visible active blocks`);
        }

        updateSummary(summary);
        renderNavigation(activeBlocks);
        bindEvents();
        renderSectionShells();
    } catch (error) {
        showError(error);
    }
}

initialize();
