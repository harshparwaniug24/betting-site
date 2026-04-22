const axios = require('axios');

/**
 * CRICKET SETTLEMENT ARCHITECTURE (Production):
 * 1. Fetch live results from a 3rd-party Sports API (e.g. EntitySport, CricAPI).
 * 2. Identify matches with status "Finished".
 * 3. Fetch all active bets from data/bets.json for that matchId.
 * 4. Compare user selection vs. official result.
 * 5. Update user balance using users.json and trigger Socket.IO notification.
 */

// Expanded Mock data with 15+ matches and metadata
// Stable start time for the session
const sessionBase = new Date();
sessionBase.setMinutes(0, 0, 0);
const startTimeBase = sessionBase.getTime();

const generateMockOdds = () => {
    const teams = [
        ['RCB', 'MI'], ['CSK', 'GT'], ['KKR', 'SRH'], ['LSG', 'RR'],
        ['DC', 'PBKS'], ['IND', 'AUS'], ['ENG', 'NZ'], ['SA', 'PAK'],
        ['AFG', 'BAN'], ['WI', 'SL'], ['PSL: LQ', 'IU'], ['BBL: AS', 'MS'],
        ['Troll', 'Memes'], ['Devs', 'Bugs'], ['AI', 'Human'], ['Gold', 'Silver']
    ];

    const now = new Date();
    // Use the global startTimeBase for stability

    return teams.map((pair, i) => {
        const commence = new Date(startTimeBase + (i * 3600000)); // Every hour
        return {
            id: `cricket_${i + 1}`,
            home_team: pair[0],
            away_team: pair[1],
            commence_time: commence.toISOString(),
            odds: {
                back: parseFloat((1.2 + Math.random() * 2).toFixed(2)),
                lay: parseFloat((1.3 + Math.random() * 2).toFixed(2))
            },
            status: commence.getTime() <= Date.now() ? 'LIVE' : 'UPCOMING'
        };
    });
};

class CricketService {
    constructor() {
        this.cache = null;
        this.lastFetch = 0;
        this.cacheTTL = 5000; // 5 seconds for "Fast" updates
    }

    async getOdds() {
        const now = Date.now();
        if (this.cache && (now - this.lastFetch < this.cacheTTL)) {
            return this.cache;
        }

        try {
            // High-fidelity internal generator for 15+ matches
            this.cache = generateMockOdds();
            this.lastFetch = now;
            return this.cache;
        } catch (error) {
            console.error('[CRICKET] Fetch error:', error.message);
            return this.cache || [];
        }
    }
}

module.exports = new CricketService();
