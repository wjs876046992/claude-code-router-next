import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "child_process";
import { tmpdir, homedir } from "node:os";
import { CONFIG_FILE, HOME_DIR, readPresetFile, getPresetDir, loadConfigFromManifest } from "@wengine-ai/claude-code-router-shared";
import JSON5 from "json5";

export interface StatusLineModuleConfig {
    type: string;
    icon?: string;
    text: string;
    color?: string;
    background?: string;
    scriptPath?: string;
    options?: Record<string, any>;
}

export interface StatusLineThemeConfig {
    modules: StatusLineModuleConfig[];
}

export interface StatusLineInput {
    hook_event_name: string;
    session_id: string;
    transcript_path: string;
    cwd: string;
    model: {
        id: string;
        display_name: string;
    };
    workspace: {
        current_dir: string;
        project_dir: string;
    };
    version?: string;
    output_style?: {
        name: string;
    };
    cost?: {
        total_cost_usd: number;
        total_duration_ms: number;
        total_api_duration_ms: number;
        total_lines_added: number;
        total_lines_removed: number;
    };
    context_window?: {
        total_input_tokens: number;
        total_output_tokens: number;
        context_window_size: number;
        current_usage: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
        } | null;
    };
}

export interface AssistantMessage {
    type: "assistant";
    message: {
        model: string;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        };
    };
}

// ANSI Color codes
const COLORS: Record<string, string> = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    // Standard colors
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    // Bright colors
    bright_black: "\x1b[90m",
    bright_red: "\x1b[91m",
    bright_green: "\x1b[92m",
    bright_yellow: "\x1b[93m",
    bright_blue: "\x1b[94m",
    bright_magenta: "\x1b[95m",
    bright_cyan: "\x1b[96m",
    bright_white: "\x1b[97m",
    // Background colors
    bg_black: "\x1b[40m",
    bg_red: "\x1b[41m",
    bg_green: "\x1b[42m",
    bg_yellow: "\x1b[43m",
    bg_blue: "\x1b[44m",
    bg_magenta: "\x1b[45m",
    bg_cyan: "\x1b[46m",
    bg_white: "\x1b[47m",
    // Bright background colors
    bg_bright_black: "\x1b[100m",
    bg_bright_red: "\x1b[101m",
    bg_bright_green: "\x1b[102m",
    bg_bright_yellow: "\x1b[103m",
    bg_bright_blue: "\x1b[104m",
    bg_bright_magenta: "\x1b[105m",
    bg_bright_cyan: "\x1b[106m",
    bg_bright_white: "\x1b[107m",
};

// Use TrueColor (24-bit color) to support hexadecimal colors
const TRUE_COLOR_PREFIX = "\x1b[38;2;";
const TRUE_COLOR_BG_PREFIX = "\x1b[48;2;";

// Convert hexadecimal color to RGB format
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    // Remove # and spaces
    hex = hex.replace(/^#/, '').trim();

    // Handle shorthand form (#RGB -> #RRGGBB)
    if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }

    if (hex.length !== 6) {
        return null;
    }

    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Validate RGB values
    if (isNaN(r) || isNaN(g) || isNaN(b) || r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
        return null;
    }

    return { r, g, b };
}

// Get color code
function getColorCode(colorName: string): string {
    // Check if it's a named ANSI color from COLORS dictionary
    if (COLORS[colorName]) {
        return COLORS[colorName];
    }

    // Check if it's a hexadecimal color
    if (colorName.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(colorName) || /^[0-9a-fA-F]{3}$/.test(colorName)) {
        const rgb = hexToRgb(colorName);
        if (rgb) {
            return `${TRUE_COLOR_PREFIX}${rgb.r};${rgb.g};${rgb.b}m`;
        }
    }

    // Default to empty string
    return "";
}


// Variable replacement function, supports {{var}} format variable replacement
function replaceVariables(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
        return variables[varName] || "";
    });
}

// Execute script and get output
async function executeScript(scriptPath: string, variables: Record<string, string>, options?: Record<string, any>): Promise<string> {
    try {
        // Check if file exists
        await fs.access(scriptPath);

        // Use require to dynamically load script module
        const scriptModule = require(scriptPath);

        // If export is a function, call it with variables
        if (typeof scriptModule === 'function') {
            const result = scriptModule(variables, options);
            // If returns a Promise, wait for it to complete
            if (result instanceof Promise) {
                return await result;
            }
            return result;
        }

        // If export is a default function, call it
        if (scriptModule.default && typeof scriptModule.default === 'function') {
            const result = scriptModule.default(variables);
            // If returns a Promise, wait for it to complete
            if (result instanceof Promise) {
                return await result;
            }
            return result;
        }

        // If export is a string, return directly
        if (typeof scriptModule === 'string') {
            return scriptModule;
        }

        // If export is a default string, return it
        if (scriptModule.default && typeof scriptModule.default === 'string') {
            return scriptModule.default;
        }

        // Default to empty string
        return "";
    } catch (error) {
        console.error(`Error executing script ${scriptPath}:`, error);
        return "";
    }
}

// Default theme configuration - icon-less table style separated by │
const DEFAULT_THEME: StatusLineThemeConfig = {
    modules: [
        { type: "model", icon: "", text: "{{model}}", color: "bright_yellow" },
        { type: "contextBar", icon: "", text: "Context {{contextBar}} {{contextPercent}}%", color: "#22c55e" },
        { type: "gitBranch", icon: "", text: "{{gitBranch}}", color: "bright_green" },
        { type: "speed", icon: "", text: "{{tokenSpeed}}", color: "bright_green" },
        { type: "totalTokens", icon: "", text: "{{totalTokens}}", color: "bright_white" }
    ]
};

// Powerline style theme configuration
const POWERLINE_THEME: StatusLineThemeConfig = {
    modules: [
        {
            type: "workDir",
            icon: "󰉋", // nf-md-folder_outline
            text: "{{workDirName}}",
            color: "white",
            background: "bg_bright_blue"
        },
        {
            type: "gitBranch",
            icon: "", // nf-dev-git_branch
            text: "{{gitBranch}}",
            color: "white",
            background: "bg_bright_magenta"
        },
        {
            type: "model",
            icon: "󰚩", // nf-md-robot_outline
            text: "{{model}}",
            color: "white",
            background: "bg_bright_cyan"
        },
        {
            type: "contextBar",
            icon: "",
            text: "Context {{contextBar}} {{contextPercent}}%",
            color: "#22c55e",
            background: "bg_bright_black"
        },
        {
            type: "usage",
            icon: "↑", // Up arrow
            text: "{{inputTokens}}",
            color: "white",
            background: "bg_bright_green"
        },
        {
            type: "usage",
            icon: "↓", // Down arrow
            text: "{{outputTokens}}",
            color: "white",
            background: "bg_bright_yellow"
        },
        {
            type: "totalTokens",
            icon: "📋",
            text: "{{totalTokens}}",
            color: "white",
            background: "bg_bright_white"
        }
    ]
};

// Simple text theme configuration - fallback for when icons cannot be displayed.
// The default theme is icon-less already, so this mirrors it.
const SIMPLE_THEME: StatusLineThemeConfig = {
    modules: [
        { type: "model", icon: "", text: "{{model}}", color: "bright_yellow" },
        { type: "contextBar", icon: "", text: "Context {{contextBar}} {{contextPercent}}%", color: "#22c55e" },
        { type: "gitBranch", icon: "", text: "{{gitBranch}}", color: "bright_green" },
        { type: "speed", icon: "", text: "{{tokenSpeed}}", color: "bright_green" },
        { type: "totalTokens", icon: "", text: "{{totalTokens}}", color: "bright_white" }
    ]
};

// Full theme configuration - showcasing all available modules
const FULL_THEME: StatusLineThemeConfig = {
    modules: [
        {
            type: "workDir",
            icon: "󰉋",
            text: "{{workDirName}}",
            color: "bright_blue"
        },
        {
            type: "gitBranch",
            icon: "",
            text: "{{gitBranch}}",
            color: "bright_magenta"
        },
        {
            type: "model",
            icon: "󰚩",
            text: "{{model}}",
            color: "bright_cyan"
        },
        {
            type: "contextBar",
            icon: "",
            text: "Context {{contextBar}} {{contextPercent}}%",
            color: "#22c55e"
        },
        {
            type: "context",
            icon: "🪟",
            text: "{{contextPercent}}% / {{contextWindowSize}}",
            color: "bright_green"
        },
        {
            type: "speed",
            icon: "",
            text: "{{tokenSpeed}} {{isStreaming}}",
            color: "bright_yellow"
        },
        {
            type: "cost",
            icon: "💰",
            text: "{{cost}}",
            color: "bright_magenta"
        },
        {
            type: "duration",
            icon: "⏱️",
            text: "{{duration}}",
            color: "bright_white"
        },
        {
            type: "lines",
            icon: "📝",
            text: "+{{linesAdded}}/-{{linesRemoved}}",
            color: "bright_cyan"
        }
    ]
};

// Format token count with fixed-width units for stable display
function formatTokenCount(count: number): string {
    if (!Number.isFinite(count) || count < 0) {
        return '0';
    }
    if (count < 1000) {
        return `${Math.round(count)}`;
    }
    if (count < 1_000_000) {
        const val = count / 1000;
        const formatted = val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
        if (+formatted >= 1000) {
            const m = count / 1_000_000;
            return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'm';
        }
        return formatted + 'k';
    }
    const mVal = count / 1_000_000;
    const mFormatted = mVal % 1 === 0 ? mVal.toFixed(0) : mVal.toFixed(1);
    if (+mFormatted >= 1000) {
        const bVal = count / 1_000_000_000;
        return (bVal % 1 === 0 ? bVal.toFixed(0) : bVal.toFixed(1)) + 'b';
    }
    return mFormatted + 'm';
}

// Format usage information with auto unit
function formatUsage(input_tokens: number, output_tokens: number): string {
    return `${formatTokenCount(input_tokens)} ${formatTokenCount(output_tokens)}`;
}

// Calculate context window usage percentage
function calculateContextTokens(context_window: StatusLineInput['context_window']): number {
    if (!context_window || !context_window.current_usage) {
        return 0;
    }
    const { current_usage } = context_window;
    return current_usage.input_tokens +
        current_usage.cache_creation_input_tokens +
        current_usage.cache_read_input_tokens;
}

function getContextUsageColor(contextPercent: string): string {
    const percent = parseInt(contextPercent || "0", 10);
    if (percent > 75) {
        return "#ef4444";
    }
    if (percent > 50) {
        return "#eab308";
    }
    return "#22c55e";
}

function getContextCircleIcon(contextPercentStr: string): string {
    const percent = parseInt(contextPercentStr || "0", 10);
    if (percent <= 0) return "○";
    if (percent < 20) return "○";
    if (percent < 40) return "◔";
    if (percent < 60) return "◑";
    if (percent < 80) return "◕";
    return "●";
}

function getContextProgressBar(percent: number, length: number = 10): string {
    const filledLength = Math.round((percent / 100) * length);
    
    // Determine overall color based on total percentage
    let overallColor = "\x1b[32m"; // green
    if (percent >= 80) {
        overallColor = "\x1b[31m"; // red
    } else if (percent >= 50) {
        overallColor = "\x1b[33m"; // yellow
    }
    
    let result = "";
    for (let i = 0; i < length; i++) {
        if (i < filledLength) {
            result += `${overallColor}█\x1b[0m`;
        } else {
            result += `\x1b[90m░\x1b[0m`;
        }
    }
    return result;
}

// Format cost display
function formatCost(cost_usd: number): string {
    if (cost_usd < 0.01) {
        return `${(cost_usd * 100).toFixed(2)}¢`;
    }
    return `$${cost_usd.toFixed(2)}`;
}

// Format duration
function formatDuration(ms: number): string {
    if (Number.isNaN(ms)) {
        return ''
    }
    if (ms < 1000) {
        return `${ms}ms`;
    } else if (ms < 60000) {
        return `${(ms / 1000).toFixed(1)}s`;
    } else {
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(0);
        if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
            return ''
        }
        return `${minutes}m${seconds}s`;
    }
}

const MAX_TOKEN_SPEED = 999;
const USAGE_DB_FILE = path.join(HOME_DIR, "data", "usage.sqlite");
const TOKEN_SPEED_VARIABLE_PATTERN = /\{\{\s*tokenSpeed\s*\}\}/;
const TOKEN_TIMING_VARIABLE_PATTERN = /\{\{\s*(tokenSpeed|isStreaming|streamingIndicator|timeToFirstToken)\s*\}\}/;

type TokenSpeedTiming = {
    durationMs: number;
    ttftMs: number;
    tokensPerSecond: number;
    timestamp: number;
};

// Read timing data from token-speed temp files.
async function getTokenSpeedTiming(sessionId: string): Promise<TokenSpeedTiming | null> {
    try {
        const tempDir = path.join(tmpdir(), 'claude-code-router');
        try { await fs.access(tempDir); } catch { return null; }

        const files = await fs.readdir(tempDir);
        const exactFile = `session-${sessionId}.json`;
        const timestampedPattern = new RegExp(`^session-${sessionId}-\\d+\\.json$`);
        const candidateFiles = files.filter((file) => file === exactFile || timestampedPattern.test(file));
        if (candidateFiles.length === 0) return null;

        let latestData: any = null;
        let latestTimestamp = 0;
        for (const file of candidateFiles) {
            try {
                const filePath = path.join(tempDir, file);
                const content = await fs.readFile(filePath, 'utf-8');
                const data = JSON.parse(content);
                const filenameTimestamp = parseNumericValue(file.match(/-(\\d+)\\.json$/)?.[1]);
                const fileStats = await fs.stat(filePath);
                const timestamp = parseNumericValue(data.timestamp) || filenameTimestamp || fileStats.mtimeMs;
                if (!latestData || timestamp >= latestTimestamp) {
                    latestData = data;
                    latestTimestamp = timestamp;
                }
            } catch {
                // Ignore corrupt temp files and continue scanning candidates.
            }
        }
        if (!latestData) return null;
        const data = latestData;

        // Parse duration (e.g. "9.99s") and TTFT (e.g. "9994ms")
        const durationMs = parseDurationToMs(data.duration);
        const ttftMs = parseDurationToMs(data.timeToFirstToken);
        if (!durationMs && !data.tokensPerSecond) return null;

        return {
            durationMs,
            ttftMs,
            tokensPerSecond: parseNumericValue(data.tokensPerSecond),
            timestamp: data.timestamp || 0
        };
    } catch {
        return null;
    }
}

function parseNumericValue(value: any): number {
    if (value == null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function hasTokenSpeedValue(value: any): boolean {
    return Math.round(parseNumericValue(value)) > 0;
}

// Resolve the auto-compact window the user actually configured. Claude Code does
// not reliably inject project-level settings env into the statusline child
// process, so process.env alone can miss a value set in a project's
// settings.local.json and the percentage falls back to the model's full window
// (e.g. 1M). Read the settings files directly as a fallback, preferring the
// project file (CCR writes the managed value there) over the global one.
function resolveConfiguredContextWindow(workDir: string): number {
    const fromEnv = parseNumericValue(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    if (fromEnv > 0) return Math.floor(fromEnv);

    const candidates = [
        path.join(workDir, ".claude", "settings.local.json"),
        path.join(homedir(), ".claude", "settings.json"),
    ];
    for (const candidate of candidates) {
        try {
            // Synchronous read: statusline is a short-lived process and must
            // return quickly; fs/promises would add async overhead per call.
            const raw = require("fs").readFileSync(candidate, "utf-8");
            const env = (JSON5.parse(raw) || {}).env;
            const value = parseNumericValue(env && env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
            if (value > 0) return Math.floor(value);
        } catch {
            // Missing or unreadable settings file — try the next candidate.
        }
    }
    return 0;
}

function normalizeTokenSpeed(value: any): number {
    const speed = Math.round(parseNumericValue(value));
    if (speed <= 0) return 0;
    return Math.min(speed, MAX_TOKEN_SPEED);
}

function calculateEstimatedTokenSpeed(outputTokens: number, durationMs: number, ttftMs: number): number {
    if (outputTokens <= 0 || durationMs <= 0) return 0;
    const decodeDurationMs = Math.max(durationMs - Math.max(ttftMs, 0), 1000);
    return Math.round(outputTokens / (decodeDurationMs / 1000));
}

function readLatestUsageSpeedFromSqlite(sessionId: string): number {
    try {
        const Database = require('better-sqlite3');
        const db = new Database(USAGE_DB_FILE, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare(`
                SELECT tokens_per_second
                FROM usage_records
                WHERE session_id = ? AND status = 'success' AND tokens_per_second IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT 1
            `).get(sessionId) as { tokens_per_second?: unknown } | undefined;
            const speed = Math.round(parseNumericValue(row?.tokens_per_second));
            return speed > 0 ? speed : 0;
        } finally {
            db.close();
        }
    } catch {
        return 0;
    }
}

function moduleNeedsTokenSpeedData(module: StatusLineModuleConfig): boolean {
    return module.type === "speed" || TOKEN_SPEED_VARIABLE_PATTERN.test(module.text || "");
}

function moduleNeedsTokenTimingData(module: StatusLineModuleConfig): boolean {
    return module.type === "speed" || TOKEN_TIMING_VARIABLE_PATTERN.test(module.text || "");
}

function getRenderedModules(theme: StatusLineThemeConfig, isPowerline: boolean): StatusLineModuleConfig[] {
    const modules = theme.modules || [];
    return isPowerline ? modules.slice(0, 10) : modules;
}

function themeNeedsTokenSpeedData(theme: StatusLineThemeConfig, isPowerline: boolean): boolean {
    return getRenderedModules(theme, isPowerline).some(moduleNeedsTokenSpeedData);
}

function themeNeedsTokenTimingData(theme: StatusLineThemeConfig, isPowerline: boolean): boolean {
    return getRenderedModules(theme, isPowerline).some(moduleNeedsTokenTimingData);
}

// Parse duration strings like "9.99s", "9994ms", "1m30s" to milliseconds
function parseDurationToMs(value: any): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;

    const str = value.trim();
    const msMatch = str.match(/^([\d.]+)ms$/);
    if (msMatch) return parseFloat(msMatch[1]);

    const sMatch = str.match(/^([\d.]+)s$/);
    if (sMatch) return parseFloat(sMatch[1]) * 1000;

    const mMatch = str.match(/^(\d+)m([\d.]+)s$/);
    if (mMatch) return parseInt(mMatch[1]) * 60000 + parseFloat(mMatch[2]) * 1000;

    return 0;
}

const SESSION_TOTALS_DIR = path.join(tmpdir(), 'claude-code-router');

// Persist and retrieve session-level peak token totals.
// Guarantees monotonically non-decreasing values across all statusline invocations
// within a session, even when transcript parsing fails mid-stream or context_window
// shrinks after compaction.
async function getSessionPeakTotal(
    sessionId: string,
    currentInputTokens: number,
    currentOutputTokens: number,
): Promise<number> {
    const filePath = path.join(SESSION_TOTALS_DIR, `totals-${sessionId}.json`);
    const current = currentInputTokens + currentOutputTokens;

    try {
        await fs.access(SESSION_TOTALS_DIR);
    } catch {
        return current;
    }

    let peak = 0;
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const cached = JSON.parse(raw);
        peak = cached.peak || 0;
    } catch {
        // first call or corrupt file
    }

    peak = Math.max(peak, current);

    try {
        await fs.writeFile(filePath, JSON.stringify({ peak, ts: Date.now() }), 'utf-8');
    } catch {
        // write failure must not break statusline
    }

    return peak;
}

// Read theme configuration from user home directory
async function getProjectThemeConfig(): Promise<{ theme: StatusLineThemeConfig | null, style: string }> {
    try {
        // Only use fixed configuration file in home directory
        const configPath = CONFIG_FILE;

        // Check if configuration file exists
        try {
            await fs.access(configPath);
        } catch {
            return { theme: null, style: 'default' };
        }

        const configContent = await fs.readFile(configPath, "utf-8");
        const config = JSON5.parse(configContent);

        // Check if there's StatusLine configuration
        if (config.StatusLine) {
            // Get current style, default to 'default'
            const currentStyle = config.StatusLine.currentStyle || 'default';

            // Check if there's configuration for the corresponding style
            if (config.StatusLine[currentStyle] && config.StatusLine[currentStyle].modules) {
                return { theme: config.StatusLine[currentStyle], style: currentStyle };
            }
        }
    } catch (error) {
        // Return null if reading fails
        // console.error("Failed to read theme config:", error);
    }

    return { theme: null, style: 'default' };
}

// Read theme configuration from preset
async function getPresetThemeConfig(presetName: string): Promise<{ theme: StatusLineThemeConfig | null, style: string }> {
    try {
        // Read preset manifest
        const manifest = await readPresetFile(presetName);
        if (!manifest) {
            return { theme: null, style: 'default' };
        }

        // Load preset configuration (applies userValues if present)
        const presetDir = getPresetDir(presetName);
        const config = loadConfigFromManifest(manifest, presetDir);

        // Check if there's StatusLine configuration in preset
        if (config.StatusLine) {
            // Get current style, default to 'default'
            const currentStyle = config.StatusLine.currentStyle || 'default';

            // Check if there's configuration for the corresponding style
            if (config.StatusLine[currentStyle] && config.StatusLine[currentStyle].modules) {
                return { theme: config.StatusLine[currentStyle], style: currentStyle };
            }
        }
    } catch (error) {
        // Return null if reading fails
        // console.error("Failed to read preset theme config:", error);
    }

    return { theme: null, style: 'default' };
}

// Check if simple theme should be used (fallback scheme)
// When environment variable USE_SIMPLE_ICONS is set, or when a terminal that might not support Nerd Fonts is detected
function shouldUseSimpleTheme(): boolean {
    // Check environment variable
    if (process.env.USE_SIMPLE_ICONS === 'true') {
        return true;
    }

    // Check terminal type (some common terminals that don't support complex icons)
    const term = process.env.TERM || '';
    const unsupportedTerms = ['dumb', 'unknown'];
    if (unsupportedTerms.includes(term)) {
        return true;
    }

    // By default, assume terminal supports Nerd Fonts
    return false;
}

// Check if Nerd Fonts icons can be displayed correctly
// By checking terminal font information or using heuristic methods
function canDisplayNerdFonts(): boolean {
    // If environment variable explicitly specifies simple icons, Nerd Fonts cannot be displayed
    if (process.env.USE_SIMPLE_ICONS === 'true') {
        return false;
    }

    // Check some common terminal environment variables that support Nerd Fonts
    const fontEnvVars = ['NERD_FONT', 'NERDFONT', 'FONT'];
    for (const envVar of fontEnvVars) {
        const value = process.env[envVar];
        if (value && (value.includes('Nerd') || value.includes('nerd'))) {
            return true;
        }
    }

    // Check terminal type
    const termProgram = process.env.TERM_PROGRAM || '';
    const supportedTerminals = ['iTerm.app', 'vscode', 'Hyper', 'kitty', 'alacritty'];
    if (supportedTerminals.includes(termProgram)) {
        return true;
    }

    // Check COLORTERM environment variable
    const colorTerm = process.env.COLORTERM || '';
    if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) {
        return true;
    }

    // By default, assume Nerd Fonts can be displayed (but allow users to override via environment variables)
    return process.env.USE_SIMPLE_ICONS !== 'true';
}

export async function parseStatusLineData(input: StatusLineInput, presetName?: string): Promise<string> {
    try {
        // Check if simple theme should be used
        const useSimpleTheme = shouldUseSimpleTheme();

        // Check if Nerd Fonts icons can be displayed
        const canDisplayNerd = canDisplayNerdFonts();

        // Determine which theme to use: use simple theme if user forces it or Nerd Fonts cannot be displayed
        const effectiveTheme = useSimpleTheme || !canDisplayNerd ? SIMPLE_THEME : DEFAULT_THEME;

        // Get theme configuration: preset config > home directory config > default theme
        let projectTheme: StatusLineThemeConfig | null = null;
        let currentStyle = 'default';

        if (presetName) {
            // Try to get theme configuration from preset first
            const presetConfig = await getPresetThemeConfig(presetName);
            projectTheme = presetConfig.theme;
            currentStyle = presetConfig.style;
        }

        // If preset theme not found or no preset specified, try home directory config
        if (!projectTheme) {
            const homeConfig = await getProjectThemeConfig();
            projectTheme = homeConfig.theme;
            currentStyle = homeConfig.style;
        }

        const theme = projectTheme || effectiveTheme;
        const isPowerline = currentStyle === 'powerline';
        const needsTokenTimingData = themeNeedsTokenTimingData(theme, isPowerline);
        const needsTokenSpeedData = themeNeedsTokenSpeedData(theme, isPowerline);

        // Get current working directory and Git branch
        const workDir = input.workspace.current_dir;
        let gitBranch = "";

        try {
            // Try to get Git branch name
            gitBranch = execSync("git branch --show-current", {
                cwd: workDir,
                stdio: ["pipe", "pipe", "ignore"],
            })
                .toString()
                .trim();
        } catch (error) {
            // If not a Git repository or retrieval fails, ignore error
        }

        // Read last assistant message from transcript_path file
        const transcriptContent = await fs.readFile(input.transcript_path, "utf-8");
        const lines = transcriptContent.trim().split("\n");

        // Traverse in reverse to find last assistant message
        let model = "";
        let inputTokens = 0;
        let outputTokens = 0;
        // Latest assistant message's context usage (same basis as
        // calculateContextTokens): used as a fallback for the context percent
        // when Claude Code's current_usage snapshot is transiently empty.
        let transcriptContextTokens = 0;

        // Also accumulate total tokens from all assistant messages
        let sessionTotalInputTokens = 0;
        let sessionTotalOutputTokens = 0;
        let sessionTotalCacheCreationTokens = 0;
        let sessionTotalCacheReadTokens = 0;
        let sessionTotalEffectiveTokens = 0;

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const message: AssistantMessage = JSON.parse(lines[i]);
                // Skip synthetic messages (e.g. "<synthetic>" written by Claude Code
                // during auto-compact / interruption recovery). They are not real LLM
                // responses, so their model name and usage must not be used.
                if (
                    message.type === "assistant" &&
                    message.message.model &&
                    !/^<.+>$/.test(message.message.model)
                ) {
                    // Accumulate tokens for session total
                    if (message.message.usage) {
                        const usage = message.message.usage;
                        sessionTotalInputTokens += usage.input_tokens;
                        sessionTotalOutputTokens += usage.output_tokens;
                        sessionTotalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
                        sessionTotalCacheReadTokens += usage.cache_read_input_tokens || 0;
                        // Per-message effective total: input is always net of cache
                        sessionTotalEffectiveTokens += usage.input_tokens
                            + (usage.cache_read_input_tokens || 0)
                            + (usage.cache_creation_input_tokens || 0)
                            + usage.output_tokens;
                    }

                    // Get last message's model and tokens
                    if (!model) {
                        model = message.message.model;
                        if (message.message.usage) {
                            const usage = message.message.usage;
                            inputTokens = usage.input_tokens;
                            outputTokens = usage.output_tokens;
                            // Mirror calculateContextTokens' basis so this is a
                            // faithful stand-in for the live current_usage snapshot.
                            transcriptContextTokens = usage.input_tokens
                                + (usage.cache_creation_input_tokens || 0)
                                + (usage.cache_read_input_tokens || 0);
                        }
                    }
                }
            } catch (parseError) {
                // Ignore parse errors, continue searching
                continue;
            }
        }

        // If model name not retrieved from transcript, try to get from configuration file
        if (!model) {
            try {
                // Get project configuration file path
                const projectConfigPath = path.join(workDir, ".claude-code-router", "config.json");
                let configPath = projectConfigPath;

                // Check if project configuration file exists, if not use user home directory configuration file
                try {
                    await fs.access(projectConfigPath);
                } catch {
                    configPath = CONFIG_FILE;
                }

                // Read configuration file
                const configContent = await fs.readFile(configPath, "utf-8");
                const config = JSON5.parse(configContent);

                // Get model name from Router field's default content
                if (config.Router && config.Router.default) {
                    const [, defaultModel] = config.Router.default.split(",");
                    if (defaultModel) {
                        model = defaultModel.trim();
                    }
                }
            } catch (configError) {
                // If configuration file reading fails, ignore error
            }
        }

        // If still unable to get model name, use display_name from input JSON data's model field
        if (!model) {
            model = input.model.display_name;
        }

        // Get working directory name
        const workDirName = workDir.split("/").pop() || "";

        // Format usage information
        const usage = formatUsage(inputTokens, outputTokens);
        const [formattedInputTokens, formattedOutputTokens] = usage.split(" ");

        let formattedTokenSpeed = '';
        let isStreaming = false;
        let streamingIndicator = '';
        let formattedTimeToFirstToken = '';

        if (needsTokenTimingData) {
            const currentOutputTokens = input.context_window?.current_usage?.output_tokens || 0;
            const timingData = await getTokenSpeedTiming(input.session_id);
            let tokenSpeed = 0;

            if (timingData) {
                const ageInSeconds = (Date.now() - timingData.timestamp) / 1000;
                isStreaming = ageInSeconds <= 3 && (currentOutputTokens > 0 || hasTokenSpeedValue(timingData.tokensPerSecond));

                if (needsTokenSpeedData) {
                    // Prefer measured speed from token-speed over any derived estimate.
                    tokenSpeed = normalizeTokenSpeed(timingData.tokensPerSecond);

                    if (!tokenSpeed) {
                        tokenSpeed = normalizeTokenSpeed(readLatestUsageSpeedFromSqlite(input.session_id));
                    }

                    if (!tokenSpeed && currentOutputTokens > 0 && timingData.durationMs > 0) {
                        tokenSpeed = normalizeTokenSpeed(calculateEstimatedTokenSpeed(currentOutputTokens, timingData.durationMs, timingData.ttftMs));
                    }
                }

                if (timingData.ttftMs) {
                    formattedTimeToFirstToken = formatDuration(timingData.ttftMs);
                }
            } else if (needsTokenSpeedData) {
                tokenSpeed = normalizeTokenSpeed(readLatestUsageSpeedFromSqlite(input.session_id));
            }

            formattedTokenSpeed = tokenSpeed > 0 ? tokenSpeed.toString() : '';
            streamingIndicator = isStreaming ? '[Streaming]' : '';
        }

        // Process context window data.
        // Prefer the context window configured via the CLAUDE_CODE_AUTO_COMPACT_WINDOW
        // env var (written by CCR from the top-level ContextWindow setting) over Claude
        // Code's own context_window_size, so the statusline reflects the actual
        // auto-compact threshold the user configured rather than the model's full window
        // (which Claude Code always reports, even when a lower compact window is set).
        const rawContextUsedTokens = input.context_window ? calculateContextTokens(input.context_window) : 0;
        const configuredContextWindow = resolveConfiguredContextWindow(workDir);
        const contextWindowSize = configuredContextWindow > 0
            ? configuredContextWindow
            : (input.context_window?.context_window_size || 0);
        // current_usage is Claude Code's per-turn snapshot and is transiently
        // empty (null / zero) during brief windows — a request in flight, or just
        // after auto-compact. Falling back to the last assistant message's context
        // usage from the transcript keeps the percent stable instead of flashing
        // 0% until the next snapshot arrives.
        const contextUsedTokens = rawContextUsedTokens > 0
            ? rawContextUsedTokens
            : transcriptContextTokens;
        const contextPercent = contextWindowSize
            ? Math.round((contextUsedTokens / contextWindowSize) * 100)
            : 0;

        // Session total tokens: persist a session-level peak to guarantee monotonicity.
        // Take the max of transcript accumulation and context_window as the current
        // candidate, then floor it at the historical peak for this session.
        const cwTotalInput = input.context_window?.total_input_tokens ?? 0;
        const cwTotalOutput = input.context_window?.total_output_tokens ?? 0;
        const sessionTotalInputWithCache = sessionTotalInputTokens + sessionTotalCacheCreationTokens + sessionTotalCacheReadTokens;
        const totalInputTokens = Math.max(sessionTotalInputWithCache, cwTotalInput);
        const totalOutputTokens = Math.max(sessionTotalOutputTokens, cwTotalOutput);
        const effectiveTotalTokens = await getSessionPeakTotal(
            input.session_id,
            totalInputTokens,
            totalOutputTokens,
        );

        // Process cost data
        const totalCost = input.cost?.total_cost_usd || 0;
        const formattedCost = totalCost > 0 ? formatCost(totalCost) : '';
        const totalDuration = input.cost?.total_duration_ms || 0;
        const formattedDuration = totalDuration > 0 ? formatDuration(totalDuration) : '';
        const linesAdded = input.cost?.total_lines_added || 0;
        const linesRemoved = input.cost?.total_lines_removed || 0;

        // Define variable replacement mapping
        const variables: Record<string, string> = {
            workDirName,
            gitBranch,
            model,
            inputTokens: formattedInputTokens,
            outputTokens: formattedOutputTokens,
            tokenSpeed: formattedTokenSpeed || '0',
            isStreaming: isStreaming ? 'streaming' : '',
            timeToFirstToken: formattedTimeToFirstToken,
            contextPercent: contextPercent.toString(),
            contextBar: getContextProgressBar(contextPercent),
            contextUsedTokens: formatTokenCount(contextUsedTokens),
            contextUsage: contextWindowSize ? `${formatTokenCount(contextUsedTokens)}/${formatTokenCount(contextWindowSize)}` : '',
            streamingIndicator,
            contextWindowSize: formatTokenCount(contextWindowSize),
            totalInputTokens: formatTokenCount(totalInputTokens),
            totalOutputTokens: formatTokenCount(totalOutputTokens),
            totalTokens: formatTokenCount(effectiveTotalTokens),
            cost: formattedCost || '',
            duration: formattedDuration || '',
            linesAdded: linesAdded.toString(),
            linesRemoved: linesRemoved.toString(),
            netLines: (linesAdded - linesRemoved).toString(),
            version: input.version || '',
            sessionId: input.session_id.substring(0, 8)
        };

        // Render status line based on style
        if (isPowerline) {
            return await renderPowerlineStyle(theme, variables);
        } else {
            return await renderDefaultStyle(theme, variables);
        }
    } catch (error) {
        // Return empty string on error
        return "";
    }
}

// Render default style status line
async function renderDefaultStyle(
    theme: StatusLineThemeConfig,
    variables: Record<string, string>
): Promise<string> {
    const modules = theme.modules || DEFAULT_THEME.modules;
    const parts: string[] = [];

    // Iterate through module array, rendering each module (maximum 10)
    for (let i = 0; i < modules.length; i++) {
        let module = modules[i];

        // Auto-upgrade legacy contextCircle to contextBar
        if (module.type === "contextCircle") {
            module = {
                ...module,
                type: "contextBar",
                icon: "",
                text: "Context {{contextBar}} {{contextPercent}}%"
            };
        }

        const dynamicColor = module.type === "contextCircle" || module.type === "contextBar"
            ? getContextUsageColor(variables.contextPercent)
            : module.color || "";

        const color = dynamicColor ? getColorCode(dynamicColor) : "";
        const background = module.background ? getColorCode(module.background) : "";
        let icon = module.icon || "";

        // If script type, execute script to get text
        let text = "";
        if (module.type === "script" && module.scriptPath) {
            text = await executeScript(module.scriptPath, variables, module.options);
        } else {
            text = replaceVariables(module.text, variables);
        }

        // Build display text with icon isolation to prevent display issues
        // U+FEFF (ZERO WIDTH NO-BREAK SPACE) acts as a transparent barrier before icons
        let displayText = "";
        if (icon) {
            displayText += `﻿${icon} `;
        }
        displayText += text;

        // Skip module if displayText is empty or only has icon without actual text
        if (!displayText || !text) {
            continue;
        }

        // Build module string (plain text, Claude Code statusline does not support ANSI)
        parts.push(displayText);
    }

    // Join all parts with double spaces for clearer visual separation
    // Prevents emoji-width issues where single space might visually overlap
    return parts.join(" │ ");
}

// Powerline symbols
const SEP_RIGHT = "\uE0B0"; // 

// Color numbers (256-color table)
const COLOR_MAP: Record<string, number> = {
    // Basic colors mapped to 256 colors
    black: 0,
    red: 1,
    green: 2,
    yellow: 3,
    blue: 4,
    magenta: 5,
    cyan: 6,
    white: 7,
    bright_black: 8,
    bright_red: 9,
    bright_green: 10,
    bright_yellow: 11,
    bright_blue: 12,
    bright_magenta: 13,
    bright_cyan: 14,
    bright_white: 15,
    // Bright background color mapping
    bg_black: 0,
    bg_red: 1,
    bg_green: 2,
    bg_yellow: 3,
    bg_blue: 4,
    bg_magenta: 5,
    bg_cyan: 6,
    bg_white: 7,
    bg_bright_black: 8,
    bg_bright_red: 9,
    bg_bright_green: 10,
    bg_bright_yellow: 11,
    bg_bright_blue: 12,
    bg_bright_magenta: 13,
    bg_bright_cyan: 14,
    bg_bright_white: 15,
    // Custom color mapping
    bg_bright_orange: 202,
    bg_bright_purple: 129,
};

// Get TrueColor RGB value
function getTrueColorRgb(colorName: string): { r: number; g: number; b: number } | null {
    // If predefined color, return corresponding RGB
    if (COLOR_MAP[colorName] !== undefined) {
        const color256 = COLOR_MAP[colorName];
        return color256ToRgb(color256);
    }

    // Handle hexadecimal color
    if (colorName.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(colorName) || /^[0-9a-fA-F]{3}$/.test(colorName)) {
        return hexToRgb(colorName);
    }

    // Handle background color hexadecimal
    if (colorName.startsWith('bg_#')) {
        return hexToRgb(colorName.substring(3));
    }

    return null;
}

// Convert 256-color table index to RGB value
function color256ToRgb(index: number): { r: number; g: number; b: number } | null {
    if (index < 0 || index > 255) return null;

    // ANSI 256-color table conversion
    if (index < 16) {
        // Basic colors
        const basicColors = [
            [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
            [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
            [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
            [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
        ];
        return { r: basicColors[index][0], g: basicColors[index][1], b: basicColors[index][2] };
    } else if (index < 232) {
        // 216 colors: 6×6×6 color cube
        const i = index - 16;
        const r = Math.floor(i / 36);
        const g = Math.floor((i % 36) / 6);
        const b = i % 6;
        const rgb = [0, 95, 135, 175, 215, 255];
        return { r: rgb[r], g: rgb[g], b: rgb[b] };
    } else {
        // Grayscale colors
        const gray = 8 + (index - 232) * 10;
        return { r: gray, g: gray, b: gray };
    }
}

// Generate a seamless segment: text displayed on bgN, separator transitions from bgN to nextBgN
function segment(text: string, textFg: string, bgColor: string, nextBgColor: string | null): string {
    // Plain text output (Claude Code statusline does not support ANSI)
    const body = ` ${text} `;

    if (nextBgColor != null) {
        return body + ` ${SEP_RIGHT} `;
    }

    return body;
}

// Render Powerline style status line
async function renderPowerlineStyle(
    theme: StatusLineThemeConfig,
    variables: Record<string, string>
): Promise<string> {
    const modules = theme.modules || POWERLINE_THEME.modules;
    const segments: string[] = [];

    // Iterate through module array, rendering each module (maximum 10)
    for (let i = 0; i < Math.min(modules.length, 10); i++) {
        let module = modules[i];
        
        // Auto-upgrade legacy contextCircle to contextBar
        if (module.type === "contextCircle") {
            module = {
                ...module,
                type: "contextBar",
                icon: "",
                text: "Context {{contextBar}} {{contextPercent}}%"
            };
        }
        
        const color = module.type === "contextCircle" || module.type === "contextBar"
            ? getContextUsageColor(variables.contextPercent)
            : module.color || "white";
        const backgroundName = module.background || "";
        let icon = module.icon || "";

        // If script type, execute script to get text
        let text = "";
        if (module.type === "script" && module.scriptPath) {
            text = await executeScript(module.scriptPath, variables);
        } else if (module.type === "speed") {
            // speed module: use tokenSpeed variable
            text = replaceVariables(module.text, variables);
        } else {
            text = replaceVariables(module.text, variables);
        }

        // Build display text with icon isolation to prevent display issues
        // U+FEFF (ZERO WIDTH NO-BREAK SPACE) acts as a transparent barrier before icons
        let displayText = "";
        if (icon) {
            displayText += `﻿${icon} `;
        }
        displayText += text;

        // Skip module if displayText is empty or only has icon without actual text
        if (!displayText || !text) {
            continue;
        }

        // Get next module's background color (for separator)
        let nextBackground: string | null = null;
        if (i < modules.length - 1) {
            const nextModule = modules[i + 1];
            nextBackground = nextModule.background || null;
        }

        // Use module-defined background color, or provide default background color for Powerline style
        const actualBackground = backgroundName || "bg_bright_blue";

        // Generate segment, supports hexadecimal colors
        const segmentStr = segment(displayText, color, actualBackground, nextBackground);
        segments.push(segmentStr);
    }

    return segments.join("");
}
