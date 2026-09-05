const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y_9_11qcW8";

const CLIENT = {
    clientName: "WEB",
    clientVersion: "2.20260101.00.00"
};

const EMBED_CLIENT = {
    clientName: "WEB_EMBEDDED_PLAYER",
    clientVersion: "1.20260101.01.00"
};

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const MAX_PAGES = 500;
const VERIFY_CONCURRENCY = 5;
const MAX_VERIFIED = 300;
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

async function youtube(endpoint, body, client = CLIENT, visitorData = null) {
    const contextClient = {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: "en",
        gl: "US"
    };

    if (visitorData) {
        contextClient.visitorData = visitorData;
    }

    const payload = {
        context: {
            client: contextClient
        },
        ...body
    };

    const r = await fetch(
        `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Accept-Language": "en-US,en;q=0.9",
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/"
            },
            body: JSON.stringify(payload)
        }
    );

    const text = await r.text();

    if (!r.ok) {
        throw new Error(`youtube_${endpoint}_${r.status}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`youtube_${endpoint}_invalid_json`);
    }
}

function extractVisitorData(data) {
    return (
        data?.responseContext?.visitorData ||
        data?.responseContext?.serviceTrackingParams
            ?.find?.(item => item?.service === "GFEEDBACK")
            ?.params?.find?.(item => item?.key === "visitorData")
            ?.value ||
        null
    );
}

function collectPlaylistVideos(node, output, seen) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectPlaylistVideos(item, output, seen);
        }
        return;
    }

    if (node.playlistVideoRenderer) {
        const renderer = node.playlistVideoRenderer;
        const id = renderer.videoId;

        if (
            typeof id === "string" &&
            /^[A-Za-z0-9_-]{11}$/.test(id) &&
            !seen.has(id)
        ) {
            seen.add(id);

            output.push({
                id,
                title:
                    renderer.title?.runs?.map(item => item?.text || "").join("") ||
                    renderer.title?.simpleText ||
                    null
            });
        }
    }

    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            collectPlaylistVideos(value, output, seen);
        }
    }
}

function collectContinuationTokens(node, tokens, seenTokens) {
    if (!node || typeof node !== "object") {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectContinuationTokens(item, tokens, seenTokens);
        }
        return;
    }

    const directToken =
        node?.continuationCommand?.token ||
        node?.continuationEndpoint?.continuationCommand?.token ||
        node?.continuationEndpoint?.commandMetadata?.webCommandMetadata?.url?.match(
            /[?&]continuation=([^&]+)/
        )?.[1] ||
        null;

    if (
        typeof directToken === "string" &&
        directToken.length > 0 &&
        !seenTokens.has(directToken)
    ) {
        seenTokens.add(directToken);
        tokens.push(directToken);
    }

    for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
            collectContinuationTokens(value, tokens, seenTokens);
        }
    }
}

function extractPage(data, seenVideos, seenTokens) {
    const videos = [];
    const tokens = [];

    collectPlaylistVideos(data, videos, seenVideos);
    collectContinuationTokens(data, tokens, seenTokens);

    return {
        videos,
        continuation: tokens.length > 0 ? tokens[tokens.length - 1] : null
    };
}

async function getPlaylist(id) {
    const videos = [];
    const seenVideos = new Set();
    const seenTokens = new Set();

    let visitorData = null;

    let data = await youtube("browse", {
        browseId: "VL" + id
    });

    visitorData = extractVisitorData(data);

    for (let page = 0; page < MAX_PAGES; page++) {
        const result = extractPage(
            data,
            seenVideos,
            seenTokens
        );

        videos.push(...result.videos);

        if (!result.continuation) {
            break;
        }

        data = await youtube(
            "browse",
            {
                continuation: result.continuation
            },
            CLIENT,
            visitorData
        );

        visitorData = extractVisitorData(data) || visitorData;
    }

    return videos;
}

async function player(id, client) {
    return youtube(
        "player",
        {
            videoId: id,
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: {
                contentPlaybackContext: {
                    html5Preference: "HTML5_PREF_WANTS"
                }
            }
        },
        client
    );
}

function playable(data) {
    if (!data) {
        return false;
    }

    const status = data.playabilityStatus || {};

    if (status.status !== "OK") {
        return false;
    }

    if (status.playableInEmbed === false) {
        return false;
    }

    if (status.embedPreview === false) {
        return false;
    }

    if (status.embeddable === false) {
        return false;
    }

    if (!data.videoDetails) {
        return false;
    }

    const streaming = data.streamingData;

    if (!streaming) {
        return false;
    }

    const formats = Array.isArray(streaming.formats)
        ? streaming.formats.length
        : 0;

    const adaptiveFormats = Array.isArray(streaming.adaptiveFormats)
        ? streaming.adaptiveFormats.length
        : 0;

    return formats > 0 || adaptiveFormats > 0;
}

async function verify(video) {
    try {
        const embedded = await player(video.id, EMBED_CLIENT);

        if (!playable(embedded)) {
            return null;
        }

        if (
            embedded?.videoDetails?.videoId &&
            embedded.videoDetails.videoId !== video.id
        ) {
            return null;
        }

        return {
            id: video.id,
            title:
                video.title ||
                embedded?.videoDetails?.title ||
                null
        };
    } catch {
        return null;
    }
}

async function verifyAll(videos) {
    const toVerify = videos.slice(0, MAX_VERIFIED);
    const rest = videos.slice(MAX_VERIFIED);
    const result = [];
    let index = 0;

    async function worker() {
        while (true) {
            const current = index++;

            if (current >= toVerify.length) {
                return;
            }

            const verified = await verify(toVerify[current]);

            if (verified) {
                result.push(verified);
            }
        }
    }

    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    VERIFY_CONCURRENCY,
                    toVerify.length
                )
            },
            worker
        )
    );

    const map = new Map();

    for (const video of result) {
        map.set(video.id, video);
    }

    const verified = toVerify
        .map(video => map.get(video.id))
        .filter(Boolean);

    return verified.concat(rest);
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
                    totalFound: 0,
                    totalReturned: 0,
                    verified: false,
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
                    totalFound: 0,
                    totalReturned: 0,
                    verified: false,
                    error: "not_found"
                },
                404
            );
        }

        const id = url.searchParams.get("id");

        if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
            return response(
                {
                    videos: [],
                    totalFound: 0,
                    totalReturned: 0,
                    verified: false,
                    error: "invalid_playlist_id"
                },
                400
            );
        }

        const shouldVerify =
            url.searchParams.get("verify") === "1";

        try {
            const videos = await getPlaylist(id);

            const finalVideos = shouldVerify
                ? await verifyAll(videos)
                : videos;

            return response({
                videos: finalVideos,
                totalFound: videos.length,
                totalReturned: finalVideos.length,
                verified: shouldVerify,
                error: null
            });
        } catch (error) {
            return response(
                {
                    videos: [],
                    totalFound: 0,
                    totalReturned: 0,
                    verified: shouldVerify,
                    error:
                        error?.message ||
                        "unknown_error"
                },
                500
            );
        }
    }
};
