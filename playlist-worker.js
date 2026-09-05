const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y_9_11qcW8";

const CLIENT = {
    clientName: "WEB",
    clientVersion: "2.20260708.00.00"
};

const WORKER_BUILD = "2026-09-05-first-token-wins-v6";

function cors() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
}

function response(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            ...cors()
        }
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function youtubeOnce(body, visitorData) {
    const client = {
        clientName: CLIENT.clientName,
        clientVersion: CLIENT.clientVersion,
        hl: "en",
        gl: "US"
    };

    if (visitorData) {
        client.visitorData = visitorData;
    }

    const payload = {
        context: {
            client
        },
        ...body
    };

    const request = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/",
                "Cache-Control": "no-store"
            },
            body: JSON.stringify(payload),
            cf: {
                cacheTtl: 0,
                cacheEverything: false
            }
        }
    );

    const text = await request.text();

    if (!request.ok) {
        const error = new Error(`youtube_browse_${request.status}`);
        error.status = request.status;
        throw error;
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("youtube_invalid_json");
    }
}

async function youtube(body, visitorData = null) {
    const retryableStatuses = new Set([403, 429, 500, 502, 503, 504]);
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await youtubeOnce(body, visitorData);
        } catch (error) {
            lastError = error;
            const status = error && error.status;
            if (!retryableStatuses.has(status) || attempt === maxAttempts) {
                throw error;
            }
            await delay(attempt * 400);
        }
    }

    throw lastError;
}

function findVisitorData(data) {
    return data?.responseContext?.visitorData || null;
}

function isVideoId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

function extractTitleText(titleField) {
    if (!titleField) return null;
    if (typeof titleField.content === "string") return titleField.content;
    if (typeof titleField.simpleText === "string") return titleField.simpleText;
    if (Array.isArray(titleField.runs)) {
        return titleField.runs.map(run => run?.text || "").join("");
    }
    return null;
}

function extractVideoFromPlaylistVideoRenderer(renderer) {
    if (!isVideoId(renderer?.videoId)) return null;
    return {
        id: renderer.videoId,
        title: extractTitleText(renderer.title)
    };
}

function extractVideoFromLockup(lockup) {
    if (!lockup || typeof lockup !== "object") return null;
    if (!isVideoId(lockup.contentId)) return null;
    if (typeof lockup.contentType === "string" && /PLAYLIST|CHANNEL/.test(lockup.contentType)) {
        return null;
    }
    const metadata = lockup.metadata?.lockupMetadataViewModel;
    return {
        id: lockup.contentId,
        title: extractTitleText(metadata?.title)
    };
}

function extractContinuationToken(node) {
    return (
        node?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token ||
        node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token ||
        node?.continuationItemRenderer?.command?.continuationCommand?.token ||
        node?.continuationItemViewModel?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationItemViewModel?.commandExtension?.continuationCommand?.token ||
        node?.continuationItemViewModel?.command?.continuationCommand?.token ||
        node?.continuationItemViewModel?.loggingDirectives?.continuationCommand?.token ||
        node?.continuationItemViewModel?.commandContext?.onTap?.innertubeCommand?.continuationCommand?.token ||
        node?.continuationEndpoint?.continuationCommand?.token ||
        null
    );
}

function collectVideosAndContinuation(node, out, seenNodes) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (seenNodes.has(node)) {
        return;
    }
    seenNodes.add(node);

    if (Array.isArray(node)) {
        for (const item of node) {
            collectVideosAndContinuation(item, out, seenNodes);
        }
        return;
    }

    if (node.playlistVideoRenderer) {
        const video = extractVideoFromPlaylistVideoRenderer(node.playlistVideoRenderer);
        if (video) out.videos.push(video);
    }

    if (node.lockupViewModel) {
        const video = extractVideoFromLockup(node.lockupViewModel);
        if (video) out.videos.push(video);
    }

    const token = extractContinuationToken(node);
    if (token && !out.continuation) out.continuation = token;

    if (Array.isArray(node.continuations) && node.continuations.length) {
        const direct =
            node.continuations[0]?.nextContinuationData?.continuation ||
            node.continuations[0]?.reloadContinuationData?.continuation ||
            null;
        if (direct && !out.continuation) out.continuation = direct;
    }

    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            collectVideosAndContinuation(value, out, seenNodes);
        }
    }
}

function extractVideosAndContinuation(data) {
    const out = {
        videos: [],
        continuation: null
    };
    collectVideosAndContinuation(data, out, new Set());
    return out;
}

function extractAlertText(alert) {
    const renderer = alert?.alertRenderer || alert?.alertWithButtonRenderer;
    if (!renderer) return null;
    return (
        renderer.text?.simpleText ||
        (Array.isArray(renderer.text?.runs)
            ? renderer.text.runs.map(r => r?.text || "").join("")
            : null)
    );
}

function diagnoseEmptyInitialResponse(data) {
    if (data && data.error && typeof data.error === "object") {
        const code = data.error.status || data.error.code || "UNKNOWN";
        const message = data.error.message || "no message provided";
        return `youtube_innertube_error_${code}: ${message}`;
    }

    const benignAlertPhrases = ["unavailable videos are hidden"];

    if (Array.isArray(data?.alerts)) {
        for (const alert of data.alerts) {
            const text = extractAlertText(alert);
            if (text && !benignAlertPhrases.some(phrase => text.toLowerCase().includes(phrase))) {
                return `youtube_alert: ${text}`;
            }
        }
    }

    if (data?.contents?.twoColumnBrowseResultsRenderer) {
        const topKeys = Object.keys(data.contents.twoColumnBrowseResultsRenderer).join(",");
        return `playlist_renderer_not_found_in_browse_results (keys=${topKeys})`;
    }

    const topKeys = data && typeof data === "object" ? Object.keys(data).join(",") : "none";
    return `no_playlist_renderer_found (top_level_keys=${topKeys})`;
}

function findContinuationCandidates(node, results, seenNodes, path) {
    if (results.length >= 8) return;
    if (!node || typeof node !== "object") return;
    if (seenNodes.has(node)) return;
    seenNodes.add(node);

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length && results.length < 8; i++) {
            findContinuationCandidates(node[i], results, seenNodes, `${path}[${i}]`);
        }
        return;
    }

    for (const key of Object.keys(node)) {
        if (/continuation/i.test(key)) {
            results.push({
                path: `${path}.${key}`,
                sample: JSON.stringify(node[key]).slice(0, 800)
            });
        }
    }

    for (const key of Object.keys(node)) {
        if (results.length >= 8) break;
        const value = node[key];
        if (value && typeof value === "object") {
            findContinuationCandidates(value, results, seenNodes, `${path}.${key}`);
        }
    }
}

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: cors()
            });
        }

        if (request.method !== "GET") {
            return response(
                {
                    videos: [],
                    continuation: null,
                    error: "method_not_allowed"
                },
                405
            );
        }

        const url = new URL(request.url);

        if (url.pathname !== "/playlist") {
            return response(
                {
                    videos: [],
                    continuation: null,
                    error: "not_found"
                },
                404
            );
        }

        const id = url.searchParams.get("id");
        const continuation = url.searchParams.get("continuation");
        const visitorData = url.searchParams.get("visitorData");
        const debug = url.searchParams.get("debug") === "1";

        if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
            return response(
                {
                    videos: [],
                    continuation: null,
                    error: "invalid_playlist_id"
                },
                400
            );
        }

        try {
            let data;

            if (continuation) {
                data = await youtube(
                    {
                        continuation
                    },
                    visitorData || null
                );
            } else {
                data = await youtube(
                    {
                        browseId: "VL" + id
                    }
                );
            }

            const currentVisitorData =
                findVisitorData(data) ||
                visitorData ||
                null;

            const page = extractVideosAndContinuation(data);

            const uniqueVideos = [];
            const seen = new Set();

            for (const video of page.videos) {
                if (!seen.has(video.id)) {
                    seen.add(video.id);
                    uniqueVideos.push(video);
                }
            }

            if (!continuation && !uniqueVideos.length && !page.continuation) {
                return response({
                    videos: [],
                    continuation: null,
                    visitorData: currentVisitorData,
                    complete: true,
                    error: diagnoseEmptyInitialResponse(data),
                    build: WORKER_BUILD,
                    raw: debug ? JSON.stringify(data).slice(0, 6000) : undefined,
                    continuationCandidates: debug ? (() => {
                        const results = [];
                        findContinuationCandidates(data, results, new Set(), "data");
                        return results;
                    })() : undefined
                });
            }

            return response({
                videos: uniqueVideos,
                continuation: page.continuation,
                visitorData: currentVisitorData,
                complete: !page.continuation,
                error: null,
                build: WORKER_BUILD,
                raw: debug ? JSON.stringify(data).slice(0, 6000) : undefined,
                continuationCandidates: debug ? (() => {
                    const results = [];
                    findContinuationCandidates(data, results, new Set(), "data");
                    return results;
                })() : undefined
            });
        } catch (error) {
            return response(
                {
                    videos: [],
                    continuation: null,
                    visitorData: null,
                    complete: false,
                    error: error?.message || "unknown_error",
                    build: WORKER_BUILD
                },
                500
            );
        }
    }
};
