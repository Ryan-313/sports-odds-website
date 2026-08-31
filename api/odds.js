export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  const {
    sportId = "10",
    tournamentId = ""
  } = req.query;

  const BASE_URL = "https://api.oddspapi.io/v4";

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function oddsPapi(path, params = {}) {
    const search = new URLSearchParams({
      ...params,
      apiKey
    });

    const url = `${BASE_URL}${path}?${search.toString()}`;

    const response = await fetch(url);
    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        message: text || "Invalid response from OddsPAPI"
      };
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.error ||
        data?.details ||
        `OddsPAPI HTTP ${response.status}`;

      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  /*
   * Small in-memory cache.
   *
   * This is important because /sports, /markets and /tournaments
   * are billable API calls.
   */

  if (!globalThis.__sportsCache) {
    globalThis.__sportsCache = {
      data: null,
      expires: 0
    };
  }

  if (!globalThis.__tournamentsCache) {
    globalThis.__tournamentsCache = new Map();
  }

  if (!globalThis.__marketsCache) {
    globalThis.__marketsCache = {
      data: null,
      expires: 0
    };
  }

  if (!globalThis.__oddsCache) {
    globalThis.__oddsCache = new Map();
  }

  async function getSports() {
    const cache = globalThis.__sportsCache;

    if (cache.data && Date.now() < cache.expires) {
      return cache.data;
    }

    const data = await oddsPapi("/sports", {
      language: "en"
    });

    cache.data = Array.isArray(data) ? data : [];
    cache.expires = Date.now() + 24 * 60 * 60 * 1000;

    return cache.data;
  }

  async function getMarkets() {
    const cache = globalThis.__marketsCache;

    if (cache.data && Date.now() < cache.expires) {
      return cache.data;
    }

    const data = await oddsPapi("/markets", {
      language: "en"
    });

    cache.data = Array.isArray(data) ? data : [];
    cache.expires = Date.now() + 24 * 60 * 60 * 1000;

    return cache.data;
  }

  async function getTournaments(id) {
    const cached = globalThis.__tournamentsCache.get(String(id));

    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    const data = await oddsPapi("/tournaments", {
      sportId: id,
      language: "en"
    });

    const tournaments = Array.isArray(data) ? data : [];

    globalThis.__tournamentsCache.set(String(id), {
      data: tournaments,
      expires: Date.now() + 10 * 60 * 1000
    });

    return tournaments;
  }

  function getTournamentScore(tournament) {
    const live = Number(tournament.liveFixtures || 0);
    const upcoming = Number(tournament.upcomingFixtures || 0);
    const future = Number(tournament.futureFixtures || 0);

    /*
     * Prefer tournaments that actually have fixtures happening
     * soon. Live > upcoming > future.
     */
    return (
      live * 1000000 +
      upcoming * 10000 +
      future
    );
  }

  function normalizeOddsResponse(data) {
    if (Array.isArray(data)) {
      return data;
    }

    if (data && Array.isArray(data.fixtures)) {
      return data.fixtures;
    }

    if (data && data.fixtureId) {
      return [data];
    }

    return [];
  }

  function findStake(fixture) {
    const bookmakerOdds = fixture?.bookmakerOdds || {};

    /*
     * OddsPAPI normally returns the bookmaker under its slug.
     */
    return (
      bookmakerOdds.stake ||
      bookmakerOdds["Stake"] ||
      bookmakerOdds.STAKE ||
      null
    );
  }

  function extractOdds(fixture, marketsCatalog) {
    const stake = findStake(fixture);

    if (!stake) {
      return [];
    }

    const markets = stake.markets || {};
    const result = [];

    for (const [marketId, market] of Object.entries(markets)) {
      if (!market || market.marketActive === false) {
        continue;
      }

      const catalog = marketsCatalog.find(
        m => String(m.marketId) === String(marketId)
      );

      const marketName =
        catalog?.marketName ||
        catalog?.marketNameShort ||
        `Market ${marketId}`;

      const catalogOutcomes = new Map();

      if (Array.isArray(catalog?.outcomes)) {
        for (const outcome of catalog.outcomes) {
          catalogOutcomes.set(
            String(outcome.outcomeId),
            outcome.outcomeName
          );
        }
      }

      const outcomes = [];

      for (const [outcomeId, outcome] of Object.entries(
        market.outcomes || {}
      )) {
        const player =
          outcome?.players?.["0"] ||
          Object.values(outcome?.players || {})[0];

        if (!player) {
          continue;
        }

        /*
         * Do not show inactive bookmaker prices.
         */
        if (player.active === false) {
          continue;
        }

        const price = Number(player.price);

        if (!Number.isFinite(price)) {
          continue;
        }

        const outcomeName =
          catalogOutcomes.get(String(outcomeId)) ||
          player.playerName ||
          `Outcome ${outcomeId}`;

        outcomes.push({
          outcomeId,
          name: outcomeName,
          price,
          american: player.priceAmerican ?? null,
          fractional: player.priceFractional ?? null
        });
      }

      if (outcomes.length > 0) {
        result.push({
          marketId,
          marketName,
          outcomes
        });
      }
    }

    /*
     * Put the most useful markets first.
     */
    result.sort((a, b) => {
      const aName = a.marketName.toLowerCase();
      const bName = b.marketName.toLowerCase();

      const priority = name => {
        if (
          name.includes("full time") ||
          name.includes("regular time") ||
          name.includes("winner") ||
          name.includes("moneyline") ||
          name.includes("match result")
        ) {
          return 0;
        }

        if (
          name.includes("both") ||
          name.includes("total") ||
          name.includes("over") ||
          name.includes("under")
        ) {
          return 1;
        }

        if (
          name.includes("handicap") ||
          name.includes("spread")
        ) {
          return 2;
        }

        return 3;
      };

      return priority(aName) - priority(bName);
    });

    return result;
  }

  try {
    /*
     * Validate sport.
     */
    const sports = await getSports();

    const selectedSport = sports.find(
      sport => String(sport.sportId) === String(sportId)
    );

    if (!selectedSport) {
      return res.status(400).json({
        error: `Invalid sportId: ${sportId}`,
        availableSports: sports
      });
    }

    /*
     * Get markets once and cache them.
     */
    const allMarkets = await getMarkets();

    const marketsCatalog = allMarkets.filter(
      market =>
        String(market.sportId) === String(sportId)
    );

    /*
     * If the frontend supplied a tournament ID,
     * use exactly ONE tournament.
     *
     * This is the important fix for:
     * "Too many tournament IDs specified."
     */
    let selectedTournament = null;

    if (tournamentId) {
      const tournaments = await getTournaments(sportId);

      selectedTournament = tournaments.find(
        tournament =>
          String(tournament.tournamentId) ===
          String(tournamentId)
      );

      if (!selectedTournament) {
        return res.status(404).json({
          error: `Tournament ${tournamentId} was not found for ${selectedSport.sportName}.`
        });
      }
    } else {
      /*
       * Automatically find the most relevant tournament.
       */
      const tournaments = await getTournaments(sportId);

      const usable = tournaments
        .filter(tournament => {
          const live = Number(tournament.liveFixtures || 0);
          const upcoming = Number(tournament.upcomingFixtures || 0);
          const future = Number(tournament.futureFixtures || 0);

          return live > 0 || upcoming > 0 || future > 0;
        })
        .sort(
          (a, b) =>
            getTournamentScore(b) -
            getTournamentScore(a)
        );

      selectedTournament = usable[0];

      if (!selectedTournament) {
        return res.status(200).json({
          sport: selectedSport,
          tournament: null,
          fixtures: [],
          message: "No tournaments with fixtures were found."
        });
      }
    }

    const selectedTournamentId =
      selectedTournament.tournamentId;

    /*
     * Cache odds for 20 seconds.
     */
    const cacheKey =
      `${sportId}:${selectedTournamentId}:stake`;

    const cachedOdds =
      globalThis.__oddsCache.get(cacheKey);

    let rawOdds;

    if (
      cachedOdds &&
      Date.now() < cachedOdds.expires
    ) {
      rawOdds = cachedOdds.data;
    } else {
      /*
       * IMPORTANT:
       * Only ONE tournament ID is sent here.
       */
      rawOdds = await oddsPapi(
        "/odds-by-tournaments",
        {
          bookmakers: "stake",
          tournamentIds: String(selectedTournamentId),
          language: "en",
          verbosity: "3",
          oddsFormat: "decimal"
        }
      );

      globalThis.__oddsCache.set(cacheKey, {
        data: rawOdds,
        expires: Date.now() + 20 * 1000
      });

      /*
       * Give the provider a little breathing room.
       */
      await sleep(500);
    }

    const fixtures = normalizeOddsResponse(rawOdds);

    const formattedFixtures = fixtures
      .filter(fixture => {
        /*
         * We only want fixtures that actually have Stake data.
         */
        const stake = findStake(fixture);

        return (
          fixture?.hasOdds === true &&
          stake !== null
        );
      })
      .map(fixture => {
        const stake = findStake(fixture);

        return {
          fixtureId: fixture.fixtureId,

          home:
            fixture.participant1Name ||
            `Team ${fixture.participant1Id}`,

          away:
            fixture.participant2Name ||
            `Team ${fixture.participant2Id}`,

          homeId: fixture.participant1Id,
          awayId: fixture.participant2Id,

          sportId: fixture.sportId,
          sportName:
            fixture.sportName ||
            selectedSport.sportName,

          tournamentId: fixture.tournamentId,

          tournamentName:
            fixture.tournamentName ||
            selectedTournament.tournamentName,

          categoryName:
            fixture.categoryName || "",

          startTime: fixture.startTime,

          statusName:
            fixture.statusName || "Pre-Game",

          bookmaker: {
            name: "Stake",
            active:
              stake.bookmakerIsActive !== false,
            suspended:
              stake.suspended === true,
            url:
              stake.fixturePath || null
          },

          markets: extractOdds(
            fixture,
            marketsCatalog
          )
        };
      });

    /*
     * Sort by start time.
     */
    formattedFixtures.sort(
      (a, b) =>
        new Date(a.startTime || 0) -
        new Date(b.startTime || 0)
    );

    return res.status(200).json({
      success: true,

      sport: {
        id: selectedSport.sportId,
        slug: selectedSport.slug,
        name: selectedSport.sportName
      },

      tournament: {
        id: selectedTournament.tournamentId,
        name: selectedTournament.tournamentName,
        category:
          selectedTournament.categoryName || "",
        liveFixtures:
          selectedTournament.liveFixtures || 0,
        upcomingFixtures:
          selectedTournament.upcomingFixtures || 0,
        futureFixtures:
          selectedTournament.futureFixtures || 0
      },

      bookmaker: "stake",

      count: formattedFixtures.length,

      fixtures: formattedFixtures
    });
  } catch (error) {
    console.error("OddsPAPI error:", error);

    const status =
      Number.isInteger(error.status)
        ? error.status
        : 500;

    return res.status(status).json({
      success: false,
      error:
        error?.message ||
        "Failed to fetch odds",

      details:
        error?.data?.details ||
        null,

      code:
        error?.data?.code ||
        null
    });
  }
}
