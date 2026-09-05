const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y_9_11qcW8";

const CLIENT = {
    clientName: "WEB",
    clientVersion: "2.20260708.00.00"
};

const CACHE_SECONDS = 300;

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
            "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
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
                "Referer": "https://www.youtube.com/"
            },
            body: JSON.stringify(payload)
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

function findPlaylistRenderer(data) {
    if (!data || typeof data !== "object") {
        return null;
    }

    if (Array.isArray(data)) {
        for (const item of data) {
            const found = findPlaylistRenderer(item);
            if (found) {
                return found;
            }
        }

        return null;
    }

    if (data.playlistVideoListRenderer) {
        return data.playlistVideoListRenderer;
    }

    for (const value of Object.values(data)) {
        if (value && typeof value === "object") {
            const found = findPlaylistRenderer(value);

            if (found) {
                return found;
            }
        }
    }

    return null;
}

function findContinuationInRenderer(renderer) {
    if (!renderer || typeof renderer !== "object") {
        return null;
    }

    const contents = Array.isArray(renderer.contents)
        ? renderer.contents
        : [];

    for (let i = contents.length - 1; i >= 0; i--) {
        const item = contents[i];

        const token =
            item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
            item?.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token ||
            item?.continuationItemRenderer?.command?.continuationCommand?.token ||
            null;

        if (token) {
            return token;
        }
    }

    const direct =
        renderer?.continuations?.[0]?.nextContinuationData?.continuation ||
        renderer?.continuations?.[0]?.reloadContinuationData?.continuation ||
        null;

    return direct;
}

function extractInitialPage(data) {
    const renderer = findPlaylistRenderer(data);

    if (!renderer) {
        return {
            videos: [],
            continuation: null
        };
    }

    const videos = [];
    const contents = Array.isArray(renderer.contents)
        ? renderer.contents
        : [];

    for (const item of contents) {
        const video = item?.playlistVideoRenderer;

        if (!video?.videoId) {
            continue;
        }

        if (!/^[A-Za-z0-9_-]{11}$/.test(video.videoId)) {
            continue;
        }

        const title =
            video.title?.runs?.map(x => x?.text || "").join("") ||
            video.title?.simpleText ||
            null;

        videos.push({
            id: video.videoId,
            title
        });
    }

    return {
        videos,
        continuation: findContinuationInRenderer(renderer)
    };
}

function extractContinuationPage(data) {
    const videos = [];
    let continuation = null;

    const actions = Array.isArray(data?.onResponseReceivedActions)
        ? data.onResponseReceivedActions
        : [];

    for (const action of actions) {
        const append =
            action?.appendContinuationItemsAction?.continuationItems ||
            action?.reloadContinuationItemsCommand?.continuationItems ||
            [];

        for (const item of append) {
            const video = item?.playlistVideoRenderer;

            if (video?.videoId && /^[A-Za-z0-9_-]{11}$/.test(video.videoId)) {
                const title =
                    video.title?.runs?.map(x => x?.text || "").join("") ||
                    video.title?.simpleText ||
                    null;

                videos.push({
                    id: video.videoId,
                    title
                });
            }

            const token =
                item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
                item?.continuationItemRenderer?.command?.continuationCommand?.token ||
                null;

            if (token) {
                continuation = token;
            }
        }
    }

    if (!continuation) {
        const continuationContents =
            data?.continuationContents?.playlistVideoListContinuation;

        if (continuationContents) {
            const contents = Array.isArray(continuationContents.contents)
                ? continuationContents.contents
                : [];

            for (const item of contents) {
                const video = item?.playlistVideoRenderer;

                if (video?.videoId && /^[A-Za-z0-9_-]{11}$/.test(video.videoId)) {
                    const title =
                        video.title?.runs?.map(x => x?.text || "").join("") ||
                        video.title?.simpleText ||
                        null;

                    videos.push({
                        id: video.videoId,
                        title
                    });
                }

                const token =
                    item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
                    null;

                if (token) {
                    continuation = token;
                }
            }
        }
    }

    return {
        videos,
        continuation
    };
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

    if (Array.isArray(data?.alerts)) {
        for (const alert of data.alerts) {
            const text = extractAlertText(alert);
            if (text) {
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

            const page = continuation
                ? extractContinuationPage(data)
                : extractInitialPage(data);

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
                    raw: debug ? JSON.stringify(data).slice(0, 6000) : undefined
                });
            }

            return response({
                videos: uniqueVideos,
                continuation: page.continuation,
                visitorData: currentVisitorData,
                complete: !page.continuation,
                error: null,
                raw: debug ? JSON.stringify(data).slice(0, 6000) : undefined
            });
        } catch (error) {
            return response(
                {
                    videos: [],
                    continuation: null,
                    visitorData: null,
                    complete: false,
                    error: error?.message || "unknown_error"
                },
                500
            );
        }
    }
};
