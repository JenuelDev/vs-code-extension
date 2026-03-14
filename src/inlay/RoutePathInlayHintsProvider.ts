import { getRoutes } from "@src/repositories/routes";
import { config } from "@src/support/config";
import { relativePath } from "@src/support/project";
import * as vscode from "vscode";

// Command used by the inlay hint tooltip to copy the resolved route path
export const copyRoutePathCommand = "laravel.route.copyPath";

// Match files that represent Laravel route definitions.
// Examples: `routes/web.php`, `Routes/api.php`, or `modules/foo/routes/custom.php`.

const ROUTE_FILE_REGEX = /(^|[\\/])[Rr]outes?(?:[\\/].+)?\.php$/;

type ParsedRouteLine = {
    methods: string[];
    uri: string;
    name: string | null;
};

// ParsedRouteLine represents the essential data extracted from a single
// route declaration line in a PHP routes file. Keeping this minimal
// reduces work done per-line and focuses the matching logic on only
// the fields that matter for inlay hint resolution.

// Normalize filesystem paths to a project-relative style used for
// comparing discovered route file names with the current document.
const normalizePath = (input: string) =>
    input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

// Returns true when a discovered route file should be considered the
// same as (or closely related to) the file being edited. This lets the
// provider prefer routes declared in the same file as the hint.
const pathMatches = (routeFile: string, documentPath: string) => {
    if (routeFile === documentPath) {
        return true;
    }

    return (
        routeFile.endsWith(`/${documentPath}`) ||
        documentPath.endsWith(`/${routeFile}`)
    );
};

// Normalize a declared URI for matching purposes.
// - keep single-root `/` as `/`
// - otherwise strip leading/trailing slashes so comparisons like
//   `users` vs `/users/` are consistent
const normalizeUri = (input: string) => {
    const cleaned = input.trim();

    if (cleaned === "/") {
        return "/";
    }

    return cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
};

// Extract unique HTTP methods from a `match([..], ...)` declaration
// such as `['get','post']` and return them uppercased.
const parseMethodsFromMatch = (source: string): string[] =>
    Array.from(new Set(Array.from(source.matchAll(/['"]([A-Za-z]+)['"]/g), (m) => m[1].toUpperCase())));

// Parse a single source line and return the parsed route components
// when the line contains a recognizable `Route::...` declaration.
// The function is intentionally conservative so it won't try to fully
// parse PHP — it only extracts the common, one-line forms used in tests.
const parseRouteLine = (line: string): ParsedRouteLine | null => {
    const routeNameMatch = /->\s*name\s*\(\s*(['"])([^'"]+)\1\s*\)/i.exec(line);
    const routeName = routeNameMatch ? routeNameMatch[2] : null;

    const standard =
        /Route::\s*(get|post|put|patch|delete|options|head|any)\s*\(\s*(['\"])([^'\"]+)\2/i.exec(
            line,
        );

    if (standard) {
        const method = standard[1].toUpperCase();

        if (method === "ANY") {
            return {
                methods: [
                    "GET",
                    "POST",
                    "PUT",
                    "PATCH",
                    "DELETE",
                    "OPTIONS",
                    "HEAD",
                ],
                uri: standard[3],
                name: routeName,
            };
        }

        return {
            methods: [method],
            uri: standard[3],
            name: routeName,
        };
    }

    const matchRoute =
        /Route::\s*match\s*\(\s*\[([^\]]+)\]\s*,\s*(['\"])([^'\"]+)\2/i.exec(
            line,
        );

    if (matchRoute) {
        const methods = parseMethodsFromMatch(matchRoute[1]);

        if (methods.length === 0) {
            return null;
        }

        return {
            methods,
            uri: matchRoute[3],
            name: routeName,
        };
    }

    return null;
};

// Lightweight caches to avoid repeated work across provider calls.
// We create small lookup maps keyed by method and by route name so that
// the per-line matching work can consider a small candidate set instead
// of iterating the entire routes list for each parsed line.
let routesMetaCacheSig = "";
let routesByMethod = new Map<string, any[]>();
let routesByName = new Map<string, any[]>();

const getRoutesMeta = () => {
    const routes = getRoutes().items;
    const sig = routes
        .map((r) => `${r.method}|${r.uri}|${r.name || ""}|${r.filename || ""}`)
        .join(";");

    if (sig === routesMetaCacheSig) {
        return { routesByMethod, routesByName };
    }

    routesMetaCacheSig = sig;
    routesByMethod = new Map();
    routesByName = new Map();

    for (const r of routes) {
        const methods = routeMethods(r.method);

        for (const m of methods) {
            const arr = routesByMethod.get(m) ?? [];
            arr.push(r);
            routesByMethod.set(m, arr);
        }

        if (r.name) {
            const arr = routesByName.get(r.name) ?? [];
            arr.push(r);
            routesByName.set(r.name, arr);
        }
    }

    return { routesByMethod, routesByName };
};

// Cache parsed route lines keyed by the exact line text. This avoids
// repeating regex work when the provider is invoked frequently for the
// same document contents.
const parseCache = new Map<string, ParsedRouteLine | null>();

const routeMethods = (method: string) =>
    method
        .split("|")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean);

const scoreRouteMatch = (
    route: {
        method: string;
        uri: string;
        name: string;
        filename: string | null;
        line: number | null;
    },
    parsed: ParsedRouteLine,
    documentPath: string,
    lineNumber: number,
): number => {
    const declaredUri = normalizeUri(parsed.uri);
    const candidateUri = normalizeUri(route.uri);
    const methods = routeMethods(route.method);

    if (!methods.some((method) => parsed.methods.includes(method))) {
        return Number.NEGATIVE_INFINITY;
    }

    let score = 0;

    if (methods.length === 1 && parsed.methods.length === 1) {
        if (methods[0] === parsed.methods[0]) {
            score += 40;
        }
    }

    if (parsed.name && route.name === parsed.name) {
        score += 400;
    }

    if (candidateUri === declaredUri) {
        score += 300;
    } else if (
        declaredUri.length > 0 &&
        candidateUri.endsWith(`/${declaredUri}`)
    ) {
        const extraPrefix = candidateUri.length - declaredUri.length;
        score += 220 - Math.min(extraPrefix, 120);
    } else if (declaredUri === "/") {
        if (candidateUri === "/" || candidateUri === "") {
            score += 250;
        } else {
            // Routes declared as '/' can resolve to group prefixes like 'v2/users'.
            score += 180;
        }
    } else {
        return Number.NEGATIVE_INFINITY;
    }

    if (route.filename) {
        const routeFile = normalizePath(route.filename);

        if (pathMatches(routeFile, documentPath)) {
            score += 100;

            if (route.line) {
                const lineDiff = Math.abs(route.line - lineNumber - 1);

                if (lineDiff === 0) {
                    score += 1000;
                } else if (lineDiff <= 2) {
                    score += 200 - lineDiff * 50;
                }
            }
        }
    }

    return score;
};

const resolvePath = (routeUri: string) => (routeUri && routeUri !== "/") ? (routeUri.startsWith("/") ? routeUri : `/${routeUri}`) : "/";

const formatHintPath = (path: string, parsed: ParsedRouteLine) =>
    normalizeUri(parsed.uri) === "/" && path !== "/" && !path.endsWith("/") ? `${path}/` : path;

export class RoutePathInlayHintsProvider implements vscode.InlayHintsProvider {
    provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): vscode.ProviderResult<vscode.InlayHint[]> {
        if (!config("route.pathHints", true)) {
            return [];
        }

        if (!ROUTE_FILE_REGEX.test(document.fileName)) {
            return [];
        }

        const routes = getRoutes().items;

        if (routes.length === 0) {
            return [];
        }

        const hints: vscode.InlayHint[] = [];
        const documentPath = normalizePath(relativePath(document.fileName));
        const startLine = range.start.line;
        const endLine = range.end.line;

        const { routesByMethod, routesByName } = getRoutesMeta();

        for (let line = startLine; line <= endLine; line++) {
            const textLine = document.lineAt(line);
            let parsed = parseCache.get(textLine.text);

            if (parsed === undefined) {
                parsed = parseRouteLine(textLine.text);
                parseCache.set(textLine.text, parsed);
            }

            if (!parsed) continue;

            let bestRoute: (typeof routes)[number] | null = null;
            let bestScore = Number.NEGATIVE_INFINITY;

            // Narrow candidates by name or method to avoid iterating all routes
            const candidateSet = new Set<typeof routes[number]>();

            if (parsed.name && routesByName.has(parsed.name)) {
                for (const r of routesByName.get(parsed.name)!) candidateSet.add(r);
            } else {
                for (const m of parsed.methods) {
                    const list = routesByMethod.get(m);

                    if (list) for (const r of list) candidateSet.add(r);
                }
            }

            const candidates = candidateSet.size > 0 ? Array.from(candidateSet) : routes;

            for (const route of candidates) {
                const score = scoreRouteMatch(route, parsed, documentPath, line);

                if (score > bestScore) {
                    bestScore = score;
                    bestRoute = route;
                }
            }

            if (!bestRoute || bestScore <= 0) {
                continue;
            }

            const path = formatHintPath(resolvePath(bestRoute.uri), parsed);
            const position = new vscode.Position(
                line,
                textLine.range.end.character,
            );
            const hint = new vscode.InlayHint(position, [
                {
                    value: ` ${path}`,
                    tooltip: "Click to copy route path",
                    command: {
                        title: "Copy route path",
                        command: copyRoutePathCommand,
                        arguments: [path],
                    },
                },
            ]);

            hint.kind = vscode.InlayHintKind.Type;
            hint.paddingLeft = true;

            hints.push(hint);
        }

        return hints;
    }
}
