import * as http from "https";
import { parse as parseUrl } from "url";
import { getConfig } from "./config";

export interface HttpResponse {
    success: boolean;
    content: string | null;
    statusCode?: number;
    error?: string;
    attempts: number;
    source: string;
}

const ANTI_DDOS_PATTERN = /^<!DOCTYPE.*>/i;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB limit

/**
 * Performs exponential backoff for retry attempts
 * Delays: 1000ms, 2000ms, 4000ms (for attempts 1, 2, 3)
 */
function getBackoffDelay(attemptNumber: number): number {
    return 1000 * Math.pow(2, attemptNumber - 1);
}

/**
 * Checks if an error is recoverable (should retry)
 */
function isRecoverableError(error: any): boolean {
    const errorCode = error && error.code;
    const errorMessage = (error && error.message) || "";

    // Timeouts and connection errors are recoverable
    if (errorCode === "ETIMEDOUT" || errorCode === "ECONNRESET" || errorCode === "ENOTFOUND") {
        return true;
    }

    // Network-related errors are recoverable
    if (errorMessage.includes("timeout") || errorMessage.includes("ECONNREFUSED")) {
        return true;
    }

    return false;
}

/**
 * Performs a single HTTP GET request with timeout
 */
function httpGetWithTimeout(url: string, timeout: number): Promise<string> {
    const { protocol, hostname, path } = parseUrl(url);

    return new Promise((resolve, reject) => {
        let data = "";
        let responseSize = 0;
        let timedOut = false;

        const request = http.get(
            { protocol, hostname, path, timeout },
            res => {
                const statusCode = res.statusCode;

                // Check for error status codes
                if (statusCode && (statusCode < 200 || statusCode >= 300)) {
                    reject({
                        code: `HTTP_${statusCode}`,
                        message: `HTTP ${statusCode}`,
                        statusCode,
                        recoverable: statusCode >= 500 || statusCode === 429, // 429=rate limit (recoverable), 5xx=server (recoverable)
                    });
                    return;
                }

                res.on("data", chunk => {
                    responseSize += chunk.length;
                    if (responseSize > MAX_RESPONSE_SIZE) {
                        request.abort();
                        reject(new Error(`Response exceeds maximum size of ${MAX_RESPONSE_SIZE} bytes`));
                        return;
                    }
                    data += chunk;
                });

                res.on("end", () => {
                    if (!timedOut) {
                        // Check for anti-DDoS HTML response
                        if (ANTI_DDOS_PATTERN.test(data)) {
                            reject(new Error("Anti-DDoS HTML detected - service is blocking requests"));
                        } else {
                            resolve(data);
                        }
                    }
                });

                res.on("close", () => {
                    if (!timedOut && data === "") {
                        reject(new Error("Connection closed without data"));
                    }
                });
            }
        );

        request.on("timeout", () => {
            timedOut = true;
            request.abort();
            reject(new Error("Request timeout"));
        });

        request.on("error", error => {
            if (!timedOut) {
                reject(error);
            }
        });
    });
}

/**
 * Performs HTTP GET with retry logic and exponential backoff
 */
export async function getData(url: string): Promise<HttpResponse> {
    const config = getConfig();
    const timeout = config.REQUEST_TIMEOUT;
    const maxRetries = config.MAX_RETRIES;
    const debugLogging = config.ENABLE_DEBUG_LOGGING;

    let lastError: any;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        attempts = attempt;

        if (attempt > 1) {
            const delay = getBackoffDelay(attempt - 1);
            if (debugLogging) {
                console.log(`[GitIgnore Generator] Retry attempt ${attempt}/${maxRetries} for ${url} after ${delay}ms delay`);
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        try {
            if (debugLogging) {
                console.log(`[GitIgnore Generator] HTTP GET attempt ${attempt}/${maxRetries}: ${url}`);
            }

            const content = await httpGetWithTimeout(url, timeout);

            if (debugLogging) {
                console.log(`[GitIgnore Generator] Success on attempt ${attempt}: ${url}`);
            }

            return {
                success: true,
                content,
                statusCode: 200,
                attempts,
                source: url,
            };
        } catch (error) {
            lastError = error;
            const statusCode = (error as any).statusCode;

            if (debugLogging) {
                console.log(
                    `[GitIgnore Generator] Attempt ${attempt}/${maxRetries} failed: ${(error && error.message) || error} (${statusCode || "unknown"})`,
                );
            }

            if (!error.recoverable && statusCode && statusCode !== 429) {
                // Permanent error (not rate limit, not server error)
                if (debugLogging) {
                    console.log(`[GitIgnore Generator] Permanent error ${statusCode}, not retrying`);
                }
                break;
            }

            if (attempt === maxRetries) {
                break;
            }
        }
    }

    const errorMessage = (lastError && lastError.message) || "Unknown error";
    if (debugLogging) {
        console.log(`[GitIgnore Generator] All ${attempts} attempts failed for ${url}: ${errorMessage}`);
    }

    return {
        success: false,
        content: null,
        statusCode: lastError && lastError.statusCode,
        error: errorMessage,
        attempts,
        source: url,
    };
}
