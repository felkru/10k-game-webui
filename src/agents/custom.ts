
import Cookies from 'js-cookie';
import { Agent, AgentMove, GameState } from "./types";
import { FarkleEngine } from "../farkle-engine";

export class CustomAgent implements Agent {
    private getUri(playerIndex: number): string | undefined {
        return Cookies.get(`custom_agent_uri_p${playerIndex}`);
    }

    setUri(playerIndex: number, uri: string) {
        Cookies.set(`custom_agent_uri_p${playerIndex}`, uri, { expires: 365 });
    }

    async getNextMove(engine: FarkleEngine, onProgress?: (message: string) => void): Promise<AgentMove> {
        const playerIndex = engine.currentPlayerIndex;
        const uri = this.getUri(playerIndex);

        if (!uri) {
            throw new Error("No API URI configured for this player.");
        }

        const MAX_RETRIES = 5;
        const BASE_DELAY = 1000;
        const MAX_LEGAL_RETRIES = 3;

        const callApiWithRetry = async (
            lastError?: string, 
            networkRetries = MAX_RETRIES, 
            legalRetries = MAX_LEGAL_RETRIES, 
            delay = BASE_DELAY
        ): Promise<AgentMove> => {
            // Construct Game State
            const gameState: GameState = {
                message: engine.message,
                status: engine.status,
                turnScore: engine.turnScore,
                currentKeepScore: engine.currentKeepScore,
                lastError,
                dice: engine.dice.map(d => ({
                    id: d.id,
                    value: d.value,
                    state: d.state
                })),
                players: engine.players.map(p => ({
                    name: p.name,
                    score: p.score,
                    isMyTurn: p.id === engine.currentPlayerIndex
                }))
            };

            if (onProgress) {
                const attempt = MAX_RETRIES - networkRetries + 1;
                const legalAttempt = MAX_LEGAL_RETRIES - legalRetries + 1;
                let msg = `Calling Custom API: ${uri}...`;
                if (lastError) msg = `Move invalid: ${lastError}. Retrying (Legal Attempt ${legalAttempt})...`;
                if (networkRetries < MAX_RETRIES) msg = `Network issue. Retrying in ${delay/1000}s... (Attempt ${attempt})`;
                onProgress(msg);
            }

            try {
                // Fetch with timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const response = await fetch(uri, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(gameState),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    const isTransient = 
                        response.status === 429 || 
                        response.status === 503 || 
                        (response.status >= 500 && response.status < 600);

                    if (isTransient && networkRetries > 0) {
                        await new Promise(r => setTimeout(r, delay));
                        return callApiWithRetry(lastError, networkRetries - 1, legalRetries, Math.min(delay * 2, 30000));
                    }

                    const errorText = await response.text();
                    throw new Error(`API Error (${response.status}): ${errorText || response.statusText}`);
                }

                const move: AgentMove = await response.json();

                // Validation
                if (!move || typeof move.action !== 'string' || !Array.isArray(move.keepDiceIds)) {
                    throw new Error("Invalid response format from API. Expected AgentMove.");
                }

                // Legality check
                const validation = engine.validateMove(move.keepDiceIds, move.action);
                if (!validation.valid && legalRetries > 0) {
                    console.warn(`Custom Agent: Legal validation failed: ${validation.error}. Retrying...`);
                    // Delay slightly before legal retry to avoid tight loops? 
                    // Not strictly necessary as it's a new API call, but let's keep it responsive.
                    return callApiWithRetry(validation.error, MAX_RETRIES, legalRetries - 1, BASE_DELAY);
                }

                if (!validation.valid) {
                    throw new Error(`API returned invalid move after retries: ${validation.error}`);
                }

                return move;
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    if (networkRetries > 0) {
                        await new Promise(r => setTimeout(r, delay));
                        return callApiWithRetry(lastError, networkRetries - 1, legalRetries, Math.min(delay * 2, 30000));
                    }
                    throw new Error("API Request timed out after retries.");
                }

                if (networkRetries > 0 && !(error instanceof SyntaxError)) {
                    // Possible network issue
                    await new Promise(r => setTimeout(r, delay));
                    return callApiWithRetry(lastError, networkRetries - 1, legalRetries, Math.min(delay * 2, 30000));
                }

                console.error("Custom Agent Error:", error);
                throw error;
            }
        };

        return callApiWithRetry();
    }
}
