
'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PREFIX = ',';
const ORANGE = 0xffa500;
const LB_PAGE_SIZE = 5;
// Where to store per-guild config
// On Render: /data is a persistent disk (once you attach it)
// Locally: falls back to a JSON file in this folder.
const CONFIG_PATH =
  process.env.GUILD_CONFIG_PATH ||
  (process.env.RENDER
    ? '/data/discord-guild-config.json'
    : path.join(__dirname, 'discord-guild-config.json'));

// ----- Lobbies definition -----
const LOBBIES = [
  {
    key: 'us-1',
    region: 'us',
    lobby: 1,
    label: 'US $1',
    url: 'https://damnbruh-game-server-instance-1-us.onrender.com/players'
  },
  {
    key: 'us-5',
    region: 'us',
    lobby: 5,
    label: 'US $5',
    url: 'https://damnbruh-game-server-instance-5-us.onrender.com/players'
  },
  {
    key: 'us-20',
    region: 'us',
    lobby: 20,
    label: 'US $20',
    url: 'https://damnbruh-game-server-instance-20-us.onrender.com/players'
  },
  {
    key: 'eu-1',
    region: 'eu',
    lobby: 1,
    label: 'EU $1',
    url: 'https://damnbruh-game-server-instance-1-eu.onrender.com/players'
  },
  {
    key: 'eu-5',
    region: 'eu',
    lobby: 5,
    label: 'EU $5',
    url: null, // no API for this server
    noApi: true
  },
  {
    key: 'eu-20',
    region: 'eu',
    lobby: 20,
    label: 'EU $20',
    url: 'https://damnbruh-game-server-instance-20-eu.onrender.com/players'
  }
];

function getLobbyKey(region, lobby) {
  return `${region}-${lobby}`;
}

function findLobby(region, lobby) {
  return LOBBIES.find(l => l.region === region && l.lobby === lobby);
}

// ----- SOL price cache -----
let solPriceUsd = null;
let solPriceUpdatedAt = null;

async function refreshSolPrice() {
  try {
    const res = await axios.get('https://www.damnbruh.com/api/price/sol', { timeout: 5000 });
    if (res.data && res.data.success && typeof res.data.price === 'number') {
      solPriceUsd = res.data.price;
      solPriceUpdatedAt = res.data.lastUpdated ? new Date(res.data.lastUpdated) : new Date();
      console.log(`[SOL] Price updated: $${solPriceUsd} at ${solPriceUpdatedAt.toISOString()}`);
    } else {
      console.warn('[SOL] Unexpected response from price endpoint');
    }
  } catch (err) {
    console.error('[SOL] Failed to refresh price:', err.message || err);
  }
}
function formatEtTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    const options = {
      timeZone: 'America/New_York',
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    };
    let t = d.toLocaleTimeString('en-US', options); // e.g. "6:30:21 PM"
    t = t.replace(/ /g, '');                        // "6:30:21PM"
    t = t.replace('AM', 'am').replace('PM', 'pm');  // "6:30:21pm"
    return `${t} EST`;
  } catch (e) {
    return d.toISOString(); // fallback
  }
}

function solPriceStatusLine() {
  if (!solPriceUsd || !solPriceUpdatedAt) {
    return 'SOL price: unavailable (will retry every 60s)';
  }
  return `SOL price: $${solPriceUsd.toFixed(2)} (updated ${formatEtTime(solPriceUpdatedAt)})`;
}


// ----- Lobby cache and polling -----
const lobbyCache = new Map(); // key -> { data, lastFetched: Date }

async function fetchLobbyPlayers(lobbyDef) {
  // Special case: no API for this lobby (EU $5)
  if (!lobbyDef.url) {
    const cached = {
      serverId: lobbyDef.key,
      playerCount: 0,
      players: [],
      timestamp: Date.now(),
      lastFetched: new Date(),
      noApi: true
    };
    lobbyCache.set(lobbyDef.key, cached);
    return cached;
  }

  try {
    const res = await axios.get(lobbyDef.url, { timeout: 5000 });
    if (!res.data || !res.data.success) {
      throw new Error('API returned non-success');
    }
    const data = res.data;

    const players = Array.isArray(data.players) ? data.players : [];

    // Attach USD computed from current cached SOL price.
    const playersWithUsd = players.map(p => {
      let usdFromSol = null;
      if (typeof p.monetaryValue === 'number' && solPriceUsd && solPriceUsd > 0) {
        usdFromSol = p.monetaryValue * solPriceUsd;
      }
      return {
        ...p,
        usdFromSol
      };
    });

    const cached = {
      serverId: data.serverId || lobbyDef.key,
      playerCount: typeof data.playerCount === 'number' ? data.playerCount : players.length,
      players: playersWithUsd,
      timestamp: data.timestamp || Date.now(),
      lastFetched: new Date(),
      noApi: false
    };

    lobbyCache.set(lobbyDef.key, cached);
    return cached;
  } catch (err) {
    console.error(`[LOBBY] Failed to fetch ${lobbyDef.label}:`, err.message || err);
    return null;
  }
}

async function getLobbySnapshot(lobbyDef) {
  const existing = lobbyCache.get(lobbyDef.key);
  if (existing && existing.lastFetched && (Date.now() - existing.lastFetched.getTime()) < 5000) {
    return existing;
  }
  return await fetchLobbyPlayers(lobbyDef);
}
async function runRegionRefreshLoop() {
  for (const [guildId, cfg] of guildConfigs.entries()) {
    try {
      if (!cfg.refreshChannelId) continue;
      if (!cfg.defaultRegion || !['us', 'eu'].includes(cfg.defaultRegion)) continue;

      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const channel = guild.channels.cache.get(cfg.refreshChannelId);
      if (!channel || !channel.isTextBased()) continue;

      const embeds = await buildRegionSummaryEmbeds(cfg.defaultRegion);
      if (!embeds || embeds.length === 0) continue;

      // delete previous refresh message if we have one
      if (cfg.lastRefreshMessageId) {
        try {
          const prev = await channel.messages.fetch(cfg.lastRefreshMessageId);
          if (prev) await prev.delete().catch(() => {});
        } catch (e) {
          // ignore (message deleted / no perms)
        }
      }

      const msg = await channel.send({ embeds });
      cfg.lastRefreshMessageId = msg.id;
      // no ping: we send only embeds, no content
    } catch (err) {
      console.error('runRegionRefreshLoop error for guild', guildId, err.message || err);
    }
  }
}


// ----- Guild configuration (in-memory) -----
// guildId -> {
//   alertChannelId: string|null,
//   alertEnabled: { [lobbyKey]: boolean },
//   lastSeenPlayers: { [lobbyKey]: Set<string> },
//   watches: Map<number, { id, lobbyKey, threshold, intervalMinutes, lastAlertAt: Date|null }>,
//   nextWatchId: number,
//   pingRoleId: string|null,
//   defaultRegion?: string
// }
const guildConfigs = new Map();

function loadGuildConfigsFromDisk() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (!raw) return;

    const parsed = JSON.parse(raw);
    guildConfigs.clear();

    for (const [guildId, stored] of Object.entries(parsed)) {
     const cfg = {
  alertChannelId: stored.alertChannelId || null,
  alertEnabled: stored.alertEnabled || {},
  lastSeenPlayers: {},          // rebuilt at runtime
  watches: new Map(),
  nextWatchId: stored.nextWatchId || 1,
  pingRoleId: stored.pingRoleId || null,
  defaultRegion: stored.defaultRegion || null,
  refreshChannelId: stored.refreshChannelId || null,
  lastRefreshMessageId: null    // will be set at runtime
};


      if (Array.isArray(stored.watches)) {
        for (const w of stored.watches) {
          cfg.watches.set(w.id, {
            id: w.id,
            lobbyKey: w.lobbyKey,
            threshold: w.threshold,
            intervalMinutes: w.intervalMinutes,
            lastAlertAt: w.lastAlertAt ? new Date(w.lastAlertAt) : null
          });
        }
      }

      guildConfigs.set(guildId, cfg);
    }

    console.log(
      `Loaded guild config for ${guildConfigs.size} guild(s) from ${CONFIG_PATH}`
    );
  } catch (err) {
    console.error('Failed to load guild config file:', err);
  }
}

function saveGuildConfigsToDisk() {
  try {
    const obj = {};
    for (const [guildId, cfg] of guildConfigs.entries()) {
      obj[guildId] = {
  alertChannelId: cfg.alertChannelId || null,
  alertEnabled: cfg.alertEnabled || {},
  watches: Array.from(cfg.watches.values()).map(w => ({
    id: w.id,
    lobbyKey: w.lobbyKey,
    threshold: w.threshold,
    intervalMinutes: w.intervalMinutes,
    lastAlertAt: w.lastAlertAt ? w.lastAlertAt.toISOString() : null
  })),
  nextWatchId: cfg.nextWatchId || 1,
  pingRoleId: cfg.pingRoleId || null,
  defaultRegion: cfg.defaultRegion || null,
  refreshChannelId: cfg.refreshChannelId || null
};

    }

    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save guild config file:', err);
  }
}

function getGuildConfig(guildId) {
  let cfg = guildConfigs.get(guildId);
  if (!cfg) {
    cfg = {
      alertChannelId: null,
      alertEnabled: {},
      lastSeenPlayers: {},
      watches: new Map(),
      nextWatchId: 1,
      pingRoleId: null,
      defaultRegion: null,
      refreshChannelId: null,
lastRefreshMessageId: null,

    };
    guildConfigs.set(guildId, cfg);
  }
  return cfg;
}

// Load saved config once on startup
loadGuildConfigsFromDisk();


// ----- Discord client -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Start SOL price refresher
  refreshSolPrice();
  setInterval(refreshSolPrice, 60 * 1000);

  // Start lobby polling for alerts/watches
  setInterval(pollLobbiesAndProcessAlerts, 5000);
  setInterval(runRegionRefreshLoop, 60 * 1000); // every minute

});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return; // ignore DMs
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  try {
    if (command === 'lb') {
  await handleLbCommand(message, args);
} else if (command === 'us') {
  await handleRegionSummaryCommand(message, 'us');
} else if (command === 'eu') {
  await handleRegionSummaryCommand(message, 'eu');
} else if (command === 'alert') {
  await handleAlertCommand(message, args);
} else if (command === 'watch') {
  await handleWatchCommand(message, args);
} else if (command === 'config') {
  await handleConfigCommand(message, args);
}

  } catch (err) {
    console.error('Command handler error:', err);
    await message.reply('Something went wrong handling that command.');
  }
});

// Handle button interactions (leaderboard pagination)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const id = interaction.customId;
  if (!id.startsWith('lb_prev|') && !id.startsWith('lb_next|')) return;

  const parts = id.split('|');
  const action = parts[0]; // lb_prev or lb_next
  const region = parts[1];
  const lobbyNum = parseInt(parts[2], 10);
  const page = parseInt(parts[3], 10);

  const lobbyDef = findLobby(region, lobbyNum);
  if (!lobbyDef || !lobbyDef.url) {
    await interaction.reply({ content: 'No API for this server.', ephemeral: true });
    return;
  }

  const snapshot = await getLobbySnapshot(lobbyDef);
  if (!snapshot || snapshot.noApi) {
    await interaction.reply({
      content: 'Could not load lobby data right now. Please try again in a moment.',
      ephemeral: true
    });
    return;
  }

  const players = snapshot.players
    .filter(p => typeof p.size === 'number' && p.size > 3)
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  const direction = action === 'lb_prev' ? -1 : 1;
  const newPage = page + direction;

  const { embed, components } = buildLbEmbed(lobbyDef, snapshot, players, newPage);
  await interaction.update({ embeds: [embed], components });
});

// ----- Leaderboard helpers -----
function buildLbEmbed(lobbyDef, snapshot, players, page) {
  const totalPages = Math.max(1, Math.ceil(players.length / LB_PAGE_SIZE));
  let currentPage = page;
  if (currentPage < 0) currentPage = 0;
  if (currentPage > totalPages - 1) currentPage = totalPages - 1;

  const start = currentPage * LB_PAGE_SIZE;
  const pagePlayers = players.slice(start, start + LB_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(`${lobbyDef.label} Lobby Leaderboard`)
    .setColor(ORANGE);

 const headerLines = [
  `Lobby: $${lobbyDef.lobby}   Region: ${lobbyDef.region.toUpperCase()}`,
  `Players in lobby: ${players.length}`, // already filtered by size > 3
  solPriceStatusLine(),
  `Last updated: ${formatEtTime(snapshot.lastFetched || Date.now())}`,
  `Page ${currentPage + 1}/${totalPages}`
];


  if (pagePlayers.length === 0) {
    embed.setDescription(headerLines.join('\n') + '\n\nNo active players with size > 3.');
  } else {
    embed.setDescription(headerLines.join('\n'));

    pagePlayers.forEach((p, index) => {
      const rank = start + index + 1;
      const name = p.name || p.privyId || p.id || 'Unknown';

      const roundedSize = Math.round(p.size); // size to ones place
      const usdDisplay =
        typeof p.usdFromSol === 'number'
          ? `$${p.usdFromSol.toFixed(2)}` // USD to 0.01
          : '(price unavailable)';

      embed.addFields({
        name: `#${rank} ${name}`,
        value: `Size: ${roundedSize}\nUSD: ${usdDisplay}`,
        inline: false
      });
    });

  }

  const components = [];
  if (totalPages > 1) {
    const row = new ActionRowBuilder();
    if (currentPage > 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`lb_prev|${lobbyDef.region}|${lobbyDef.lobby}|${currentPage}`)
          .setLabel('◀')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (currentPage < totalPages - 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`lb_next|${lobbyDef.region}|${lobbyDef.lobby}|${currentPage}`)
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (row.components.length > 0) {
      components.push(row);
    }
  }

  return { embed, components };
}

// ----- ,lb command -----
async function handleLbCommand(message, args) {
  if (args.length < 2) {
    const embed = new EmbedBuilder()
      .setTitle('Leaderboard Command')
      .setDescription(
        [
          'Usage: `,lb <lobby> <region>`',
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const lobbyNum = parseInt(args[0], 10);
  const region = (args[1] || '').toLowerCase();

  if (![1, 5, 20].includes(lobbyNum)) {
    const embed = new EmbedBuilder()
      .setTitle('Invalid lobby')
      .setDescription(
        'Lobby must be 1, 5, or 20.\nUsage: `,lb <lobby> <region>`\nExample: `,lb 5 us`'
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }
  if (!['us', 'eu'].includes(region)) {
    const embed = new EmbedBuilder()
      .setTitle('Invalid region')
      .setDescription(
        'Region must be "us" or "eu".\nUsage: `,lb <lobby> <region>`\nExample: `,lb 5 us`'
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const lobbyDef = findLobby(region, lobbyNum);
  if (!lobbyDef) {
    const embed = new EmbedBuilder()
      .setTitle('Error')
      .setDescription('Could not find that lobby definition.')
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  // EU $5 has no API
  if (!lobbyDef.url) {
    const embed = new EmbedBuilder()
      .setTitle(lobbyDef.label)
      .setDescription('No API for this server.')
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const snapshot = await getLobbySnapshot(lobbyDef);
  if (!snapshot || snapshot.noApi) {
    const embed = new EmbedBuilder()
      .setTitle('Error')
      .setDescription(
        'Could not load lobby data right now. The game server might be offline or unreachable. Please try again in a moment.'
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const players = snapshot.players
    .filter(p => typeof p.size === 'number' && p.size > 3)
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  const { embed, components } = buildLbEmbed(lobbyDef, snapshot, players, 0);
  await message.reply({ embeds: [embed], components });
}
async function buildRegionSummaryEmbeds(region) {
  const lobbyNumbers = region === 'us' ? [1, 5, 20] : [1, 20]; // EU 5 has no API
  const embeds = [];

  for (const lobbyNum of lobbyNumbers) {
    const lobbyDef = findLobby(region, lobbyNum);
    if (!lobbyDef || !lobbyDef.url) continue;

    const snapshot = await getLobbySnapshot(lobbyDef);
    if (!snapshot || snapshot.noApi || !Array.isArray(snapshot.players)) continue;

    const activePlayers = snapshot.players
      .filter(p => typeof p.size === 'number' && p.size > 3)
      .sort((a, b) => {
        const usdA = typeof a.usdFromSol === 'number' ? a.usdFromSol : 0;
        const usdB = typeof b.usdFromSol === 'number' ? b.usdFromSol : 0;
        return usdB - usdA;
      });

    const top5 = activePlayers.slice(0, 5);
    const lastUpdated = formatEtTime(snapshot.lastFetched || Date.now());

    const lines = top5.map((p, idx) => {
      const rank = idx + 1;
      const name = p.name || p.privyId || p.id || 'Unknown';
      const usd =
        typeof p.usdFromSol === 'number'
          ? `$${p.usdFromSol.toFixed(2)}`
          : '(price unavailable)';
      return `#${rank} ${name} - ${usd}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${lobbyDef.label} Lobby Leaderboard`)
      .setColor(ORANGE)
      .setDescription(
        [
          `Lobby: $${lobbyDef.lobby}   Region: ${region.toUpperCase()}`,
          `Players in lobby: ${activePlayers.length}`,
          `Last updated: ${lastUpdated}`,
          '',
          lines.length ? lines.join('\n') : 'No active players with size > 3.'
        ].join('\n')
      );

    embeds.push(embed);
  }

  return embeds;
}

async function handleRegionSummaryCommand(message, region) {
  // which lobbies to show
  const lobbyNumbers = region === 'us' ? [1, 5, 20] : [1, 20]; // skip EU 5 (no API)
  const embeds = [];

  for (const lobbyNum of lobbyNumbers) {
    const lobbyDef = findLobby(region, lobbyNum);
    if (!lobbyDef || !lobbyDef.url) continue; // skip no-API lobby

    const snapshot = await getLobbySnapshot(lobbyDef);
    if (!snapshot || snapshot.noApi || !Array.isArray(snapshot.players)) continue;

    // only players with size > 3, sorted by USD desc
    const activePlayers = snapshot.players
      .filter(p => typeof p.size === 'number' && p.size > 3)
      .sort((a, b) => {
        const usdA = typeof a.usdFromSol === 'number' ? a.usdFromSol : 0;
        const usdB = typeof b.usdFromSol === 'number' ? b.usdFromSol : 0;
        return usdB - usdA;
      });

    const top5 = activePlayers.slice(0, 5);

    const lines = top5.map((p, idx) => {
      const rank = idx + 1;
      const name = p.name || p.privyId || p.id || 'Unknown';
      const usd =
        typeof p.usdFromSol === 'number'
          ? `$${p.usdFromSol.toFixed(2)}`
          : '(price unavailable)';
      return `#${rank} ${name} - ${usd}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${lobbyDef.label} Lobby Leaderboard`)
      .setColor(ORANGE)
      .setDescription(
        [
          `Lobby: $${lobbyDef.lobby}   Region: ${region.toUpperCase()}`,
          `Players in lobby: ${activePlayers.length}`, // size > 3 only
          '',
          lines.length ? lines.join('\n') : 'No active players with size > 3.'
        ].join('\n')
      );

    embeds.push(embed);
  }

  if (embeds.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(region === 'us' ? 'US Lobby Summary' : 'EU Lobby Summary')
      .setColor(ORANGE)
      .setDescription('No lobby data available right now.');
    await message.reply({ embeds: [embed] });
  } else {
    // one message, multiple boxes (one per lobby)
    await message.reply({ embeds });
  }
}

// ----- ,alert command -----
async function handleAlertCommand(message, args) {
  const guildId = message.guild.id;
  const cfg = getGuildConfig(guildId);
  

  const sub = (args[0] || '').toLowerCase();

  if (!sub) {
    const embed = new EmbedBuilder()
      .setTitle('Join Alert Commands')
      .setDescription(
        [
          'Usage:',
          '  `,alert on <lobby> <region>`',
          '  `,alert off <lobby> <region>`',
          '  `,alert channel #channel`',
          '  `,alert list`',
          '  `,alert status`',
        ].join('\n')
      )
      .setFooter({ text: 'Alerts ping when someone joins that lobby' })
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'channel') {
    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid channel')
        .setDescription(
          'Please mention a text channel. Example: `,alert channel #damnbruh-alerts`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    cfg.alertChannelId = channel.id;
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Alert channel set')
      .setDescription(
        `Alert channel set to ${channel}.\nJoin and watch alerts will be sent here.`
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'on' || sub === 'off') {
    if (args.length < 3) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid arguments')
        .setDescription(
          'Usage: `,alert on <lobby> <region>`\nExample: `,alert on 20 us`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    const lobbyNum = parseInt(args[1], 10);
    const region = (args[2] || '').toLowerCase();

    if (![1, 5, 20].includes(lobbyNum) || !['us', 'eu'].includes(region)) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid arguments')
        .setDescription(
          'Lobby must be 1, 5, or 20.\nRegion must be "us" or "eu".\n\nExample: `,alert on 20 us`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    const lobbyDef = findLobby(region, lobbyNum);
    if (!lobbyDef) {
      const embed = new EmbedBuilder()
        .setTitle('Error')
        .setDescription('Could not find that lobby definition.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    if (!lobbyDef.url) {
      const embed = new EmbedBuilder()
        .setTitle(lobbyDef.label)
        .setDescription('No API for this server.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'on') {
      if (!cfg.alertChannelId) {
        const embed = new EmbedBuilder()
          .setTitle('Alert channel not set')
          .setDescription('Use `,alert channel #channel` first.')
          .setColor(ORANGE);
        await message.reply({ embeds: [embed] });
        return;
      }
      const key = getLobbyKey(region, lobbyNum);
      cfg.alertEnabled[key] = true;
      if (!cfg.lastSeenPlayers[key]) {
        cfg.lastSeenPlayers[key] = new Set();
      }
      saveGuildConfigsToDisk();
      const embed = new EmbedBuilder()
        .setTitle('Join alerts enabled')
        .setDescription(
          `Join alerts enabled for ${region.toUpperCase()} $${lobbyNum} lobby in <#${cfg.alertChannelId}>.`
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
    } else {
      const key = getLobbyKey(region, lobbyNum);
      if (!cfg.alertEnabled[key]) {
        const embed = new EmbedBuilder()
          .setTitle('Join alerts already disabled')
          .setDescription(
            `Join alerts are already disabled for ${region.toUpperCase()} $${lobbyNum} lobby.`
          )
          .setColor(ORANGE);
        await message.reply({ embeds: [embed] });
        return;
      }
      cfg.alertEnabled[key] = false;
      cfg.lastSeenPlayers[key] = new Set();
      saveGuildConfigsToDisk();
      const embed = new EmbedBuilder()
        .setTitle('Join alerts disabled')
        .setDescription(
          `Join alerts disabled for ${region.toUpperCase()} $${lobbyNum} lobby.`
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
    }
    return;
  }

  if (sub === 'list') {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const usLines = [];
    const euLines = [];
    for (const lobby of LOBBIES) {
      let state;
      if (!lobby.url) {
        state = 'NO API';
      } else {
        state = cfg.alertEnabled[lobby.key] ? 'ON' : 'OFF';
      }
      const line = `$${lobby.lobby}  - ${state}`;
      if (lobby.region === 'us') usLines.push(line);
      else euLines.push(line);
    }

    const embed = new EmbedBuilder()
      .setTitle('Join Alert Status')
      .setDescription(`Alert channel: ${channelText}`)
      .addFields(
        { name: 'US lobbies', value: usLines.join('\n') || 'None', inline: true },
        { name: 'EU lobbies', value: euLines.join('\n') || 'None', inline: true }
      )
      .setFooter({
        text: 'Use ,alert on <lobby> <region> or ,alert off <lobby> <region> to change'
      })
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }


  if (sub === 'status') {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const enabled = [];
    for (const lobby of LOBBIES) {
      if (!lobby.url) continue; // skip no-API lobbies
      if (cfg.alertEnabled[lobby.key]) {
        enabled.push(`$${lobby.lobby} ${lobby.region.toUpperCase()}`);
      }
    }
    const enabledText = enabled.length ? enabled.join(', ') : 'none';

    const embed = new EmbedBuilder()
      .setTitle('Alert Status')
      .setDescription(
        [
          `Alert channel: ${channelText}`,
          'Join alerts enabled on:',
          `  ${enabledText}`
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Unknown subcommand')
    .setDescription(
      'Usage: `,alert on|off <lobby> <region>`, `,alert channel #channel`, `,alert list`, `,alert status`'
    )
    .setColor(ORANGE);
  await message.reply({ embeds: [embed] });
}

// ----- ,watch command -----
async function handleWatchCommand(message, args) {
  const guildId = message.guild.id;
  const cfg = getGuildConfig(guildId);

  const sub = (args[0] || '').toLowerCase();
  if (!sub) {
    const embed = new EmbedBuilder()
      .setTitle('Lobby Watchers')
      .setDescription(
        [
          'Watch set (minutes)',
          '',
          'Usage:',
          '  `,watch add <lobby> <region> <threshold> <minutes>`',
          '  `,watch list`',
          '  `,watch remove <id>`',
          '  `,watch clear`',
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }


const embed = new EmbedBuilder()
  .setTitle('Bot Configuration')
  .setDescription(
    [
      `Default region: ${defaultRegion}`,
      `Alert channel: ${channelText}`,
      `Refresh channel: ${refreshChannelText}`,
      `Ping role: ${pingRoleText}`,
      '',
      'Commands:',
      '  ,config default-region <us|eu>',
      '  ,config setrole @role',
      '  ,config refresh channel #channel',
      '  ,alert channel #channel'
    ].join('\n')
  )
  .setColor(ORANGE);

    const embed = new EmbedBuilder()
      .setTitle('Lobby Watchers')
      .setDescription(
        [
          'Watch set (minutes)',
          '',
          'Usage:',
          '  `,watch add <lobby> <region> <threshold> <minutes>`',
          '  `,watch list`',
          '  `,watch remove <id>`',
          '  `,watch clear`',
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'add') {
    if (args.length < 5) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid arguments')
        .setDescription(
          'Usage: `,watch add <lobby> <region> <threshold> <minutes>`\nExample: `,watch add 5 us 6 2`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    const lobbyNum = parseInt(args[1], 10);
    const region = (args[2] || '').toLowerCase();
    const threshold = parseInt(args[3], 10);
    const minutes = parseInt(args[4], 10);

    if (![1, 5, 20].includes(lobbyNum) || !['us', 'eu'].includes(region)) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid arguments')
        .setDescription(
          'Lobby must be 1, 5, or 20.\nRegion must be "us" or "eu".\n\nExample: `,watch add 5 us 6 2`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    if (!Number.isInteger(threshold) || threshold < 1) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid threshold')
        .setDescription(
          'Threshold must be a whole number of players and at least 1.\nExample: `,watch add 5 us 6 2`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid minutes')
        .setDescription(
          'Minutes must be a whole number and at least 1.\nExample: `,watch add 5 us 6 2`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    const lobbyDef = findLobby(region, lobbyNum);
    if (!lobbyDef) {
      const embed = new EmbedBuilder()
        .setTitle('Error')
        .setDescription('Could not find that lobby definition.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    if (!lobbyDef.url) {
      const embed = new EmbedBuilder()
        .setTitle(lobbyDef.label)
        .setDescription('No API for this server.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    const id = cfg.nextWatchId++;
    cfg.watches.set(id, {
      id,
      lobbyKey: lobbyDef.key,
      threshold,
      intervalMinutes: minutes,
      lastAlertAt: null
    });
    saveGuildConfigsToDisk();

    const embed = new EmbedBuilder()
      .setTitle('Watch created')
      .setDescription(
        [
          `Lobby: ${lobbyDef.label}`,
          `Threshold: ${threshold} players`,
          `Interval: ${minutes} minute(s)`
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'list') {
    if (cfg.watches.size === 0) {
      const embed = new EmbedBuilder()
        .setTitle('No active watches')
        .setDescription(
          'There are no active watches in this server.\nUse `,watch add <lobby> <region> <threshold> <minutes>` to create one.'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const embed = new EmbedBuilder()
      .setTitle('Active Lobby Watches')
      .setDescription(`Alert channel: ${channelText}`)
      .setColor(ORANGE);

    for (const [id, watch] of cfg.watches.entries()) {
      const lobbyDef = LOBBIES.find(l => l.key === watch.lobbyKey);
      const lobbyLabel = lobbyDef ? lobbyDef.label : watch.lobbyKey;
      const last = watch.lastAlertAt ? watch.lastAlertAt.toISOString() : 'never';
      embed.addFields({
        name: `${lobbyLabel} (ID ${id})`,
        value: `Threshold: ${watch.threshold} players\nInterval: ${watch.intervalMinutes} minute(s)\nLast alert: ${last}`,
        inline: false
      });
    }

    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'remove') {
    if (args.length < 2) {
      const embed = new EmbedBuilder()
        .setTitle('Usage')
        .setDescription('` ,watch remove <id> `')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    const id = parseInt(args[1], 10);
    if (!cfg.watches.has(id)) {
      const embed = new EmbedBuilder()
        .setTitle('Watch not found')
        .setDescription(
          `No watch found with ID ${id}.\nUse \`,watch list\` to see all active watches.`
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    cfg.watches.delete(id);
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Watch removed')
      .setDescription(`Watch ${id} removed.`)
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'clear') {
    if (cfg.watches.size === 0) {
      const embed = new EmbedBuilder()
        .setTitle('No watches to clear')
        .setDescription('There are no watches to clear.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    cfg.watches.clear();
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Watches cleared')
      .setDescription('All watches have been cleared for this server.')
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Unknown subcommand')
    .setDescription(
      'Usage: `,watch add`, `,watch list`, `,watch remove`, `,watch clear`'
    )
    .setColor(ORANGE);
  await message.reply({ embeds: [embed] });
}

// ----- ,config command (default-region + ping role) -----
async function handleConfigCommand(message, args) {
  const guildId = message.guild.id;
  const cfg = getGuildConfig(guildId);

  const sub = (args[0] || '').toLowerCase();

   if (!sub) {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const defaultRegion = cfg.defaultRegion || 'not set';
    const pingRoleText = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : 'No ping role given';
    const refreshChannelText = cfg.refreshChannelId ? `<#${cfg.refreshChannelId}>` : 'not set';

    const embed = new EmbedBuilder()
      .setTitle('Bot Configuration')
      .setDescription(
        [
          `Default region: ${defaultRegion}`,
          `Alert channel: ${channelText}`,
          `Refresh channel: ${refreshChannelText}`,
          `Ping role: ${pingRoleText}`,
          '',
          'Commands:',
          '  ,config default-region <us|eu>',
          '  ,config setrole @role',
          '  ,config refresh channel #channel',
          '  ,alert channel #channel'
        ].join('\n')
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }


  if (sub === 'default-region') {
    const region = (args[1] || '').toLowerCase();
    if (!['us', 'eu'].includes(region)) {
      const embed = new EmbedBuilder()
        .setTitle('Invalid region')
        .setDescription(
          'Region must be "us" or "eu".\nExample: `,config default-region us`'
        )
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    cfg.defaultRegion = region;
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Default region set')
      .setDescription(`Default region set to ${region.toUpperCase()}.`)
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'setrole') {
    const role = message.mentions.roles.first();
    if (!role) {
      cfg.pingRoleId = null;
      saveGuildConfigsToDisk();
      const embed = new EmbedBuilder()
        .setTitle('Ping role cleared')
        .setDescription('Ping role cleared. No ping role given.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }
    cfg.pingRoleId = role.id;
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Ping role set')
      .setDescription(`Ping role set to ${role}.`)
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }
  if (sub === 'refresh' && (args[1] || '').toLowerCase() === 'channel') {
    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) {
      cfg.refreshChannelId = null;
      saveGuildConfigsToDisk();
      const embed = new EmbedBuilder()
        .setTitle('Refresh channel cleared')
        .setDescription('Auto refresh disabled. No refresh channel set.')
        .setColor(ORANGE);
      await message.reply({ embeds: [embed] });
      return;
    }

    cfg.refreshChannelId = channel.id;
    saveGuildConfigsToDisk();
    const embed = new EmbedBuilder()
      .setTitle('Refresh channel set')
      .setDescription(
        `Auto lobby summary will refresh every minute in ${channel} using the default region.`
      )
      .setColor(ORANGE);
    await message.reply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Unknown subcommand')
    .setDescription(
      'Usage: `,config default-region <us|eu>`, `,config setrole @role`'
    )
    .setColor(ORANGE);
  await message.reply({ embeds: [embed] });
}

// ----- Polling loop for join alerts and watches -----
async function pollLobbiesAndProcessAlerts() {
  try {
    // Fetch all lobbies (in parallel)
    const fetchPromises = LOBBIES.map(lobby => fetchLobbyPlayers(lobby));
    await Promise.all(fetchPromises);

    // Process join alerts
    await processJoinAlerts();

    // Process watches
    await processWatches();
  } catch (err) {
    console.error('Error in pollLobbiesAndProcessAlerts:', err);
  }
}

async function processJoinAlerts() {
  for (const [guildId, cfg] of guildConfigs.entries()) {
    if (!cfg.alertChannelId) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    const channel = guild.channels.cache.get(cfg.alertChannelId);
    if (!channel || !channel.isTextBased()) continue;

    const pingContent = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : 'No ping role given';

    for (const lobby of LOBBIES) {
      const key = lobby.key;
      if (!cfg.alertEnabled[key]) continue;

      const snapshot = lobbyCache.get(key);
      if (!snapshot || snapshot.noApi || !Array.isArray(snapshot.players)) continue;

      // Only consider "real" players with size > 3
      const activePlayers = snapshot.players.filter(
        p => typeof p.size === 'number' && p.size > 3
      );
      const activeCount = activePlayers.length;

      if (activeCount === 0) {
        // no active players, reset last seen and skip
        cfg.lastSeenPlayers[key] = new Set();
        continue;
      }

      const currentIds = new Set(
        activePlayers.map(p => p.privyId || p.id).filter(Boolean)
      );

      if (!cfg.lastSeenPlayers[key]) {
        cfg.lastSeenPlayers[key] = new Set();
      }
      const lastSet = cfg.lastSeenPlayers[key];

      const newJoins = [];
      for (const id of currentIds) {
        if (!lastSet.has(id)) {
          const player = activePlayers.find(
            p => (p.privyId || p.id) === id
          );
          if (player) newJoins.push(player);
        }
      }

      cfg.lastSeenPlayers[key] = currentIds;

      if (newJoins.length === 0) continue;

      if (newJoins.length === 1) {
        const p = newJoins[0];
        const name = p.name || p.privyId || p.id || 'Unknown';
        const embed = new EmbedBuilder()
          .setTitle('Lobby Join')
          .setDescription(
            `${name} joined ${lobby.region.toUpperCase()} $${lobby.lobby} lobby.\nLobby players: ${activeCount}.`
          )
          .setColor(ORANGE);
        await channel.send({ content: pingContent, embeds: [embed] });
      } else {
        const names = newJoins
          .map(p => p.name || p.privyId || p.id || 'Unknown')
          .map(n => `• ${n}`)
          .join('\n');
        const embed = new EmbedBuilder()
          .setTitle('Lobby Joins')
          .setDescription(
            [
              `New joins in ${lobby.region.toUpperCase()} $${lobby.lobby} lobby:`,
              names,
              `Lobby players: ${activeCount}.`
            ].join('\n')
          )
          .setColor(ORANGE);
        await channel.send({ content: pingContent, embeds: [embed] });
      }
    }
  }
}


async function processWatches() {
  const now = Date.now();

  for (const [guildId, cfg] of guildConfigs.entries()) {
    if (!cfg.alertChannelId) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    const channel = guild.channels.cache.get(cfg.alertChannelId);
    if (!channel || !channel.isTextBased()) continue;

    const pingContent = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : 'No ping role given';

    for (const [id, watch] of cfg.watches.entries()) {
      const lobbyDef = LOBBIES.find(l => l.key === watch.lobbyKey);
      if (!lobbyDef) continue;

      const snapshot = lobbyCache.get(watch.lobbyKey);
      if (!snapshot || snapshot.noApi || !Array.isArray(snapshot.players)) continue;

      // Only count players with size > 3
      const activeCount = snapshot.players.filter(
        p => typeof p.size === 'number' && p.size > 3
      ).length;

      if (activeCount < watch.threshold) continue;

      const intervalMs = watch.intervalMinutes * 60 * 1000;
      const lastMs = watch.lastAlertAt ? watch.lastAlertAt.getTime() : 0;

      if (!watch.lastAlertAt || now - lastMs >= intervalMs) {
        const embed = new EmbedBuilder()
          .setTitle('Lobby Watch Alert')
          .setDescription(
            [
              `${lobbyDef.region.toUpperCase()} $${lobbyDef.lobby} lobby has ${activeCount} players.`,
              `Threshold: ${watch.threshold}. Interval: ${watch.intervalMinutes} minute(s).`
            ].join('\n')
          )
          .setColor(ORANGE);
        await channel.send({ content: pingContent, embeds: [embed] });
        watch.lastAlertAt = new Date();
      }
    }
  }
}


// ----- Start the bot -----
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set in environment or .env file.');
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});
