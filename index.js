
'use strict';

const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const PREFIX = ',';

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
    url: 'https://damnbruh-game-server-instance-5-eu.onrender.com/players'
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

function formatUsdFromSol(solAmount, usdFromCache) {
  const priceToUse = typeof usdFromCache === 'number' ? null : null;
  // We will prefer the precomputed USD value from the lobby fetch if present.
  if (typeof usdFromCache === 'number') {
    return `$${usdFromCache.toFixed(4)}`;
  }
  if (!solPriceUsd || solPriceUsd <= 0) {
    return '(price unavailable)';
  }
  const usd = solAmount * solPriceUsd;
  return `$${usd.toFixed(4)}`;
}

function solPriceStatusLine() {
  if (!solPriceUsd || !solPriceUpdatedAt) {
    return 'SOL price: unavailable (will retry every 60s)';
  }
  return `SOL price: $${solPriceUsd.toFixed(2)} (cached at ${solPriceUpdatedAt.toISOString()})`;
}

// ----- Lobby cache and polling -----
const lobbyCache = new Map(); // key -> { data, lastFetched: Date }

async function fetchLobbyPlayers(lobbyDef) {
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
      lastFetched: new Date()
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

// ----- Guild configuration (in-memory) -----
// guildId -> {
//   alertChannelId: string|null,
//   alertEnabled: { [lobbyKey]: boolean },
//   lastSeenPlayers: { [lobbyKey]: Set<string> },
//   watches: Map<number, { id, lobbyKey, threshold, intervalMinutes, lastAlertAt: Date|null }>,
//   nextWatchId: number
// }
const guildConfigs = new Map();

function getGuildConfig(guildId) {
  let cfg = guildConfigs.get(guildId);
  if (!cfg) {
    cfg = {
      alertChannelId: null,
      alertEnabled: {},
      lastSeenPlayers: {},
      watches: new Map(),
      nextWatchId: 1
    };
    guildConfigs.set(guildId, cfg);
  }
  return cfg;
}

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

// ----- ,lb command -----
async function handleLbCommand(message, args) {
  if (args.length < 2) {
    const embed = new EmbedBuilder()
      .setTitle('Leaderboard Command')
      .setDescription(
        [
          'Usage: `,lb <lobby> <region>`',
          '',
          'Lobby:',
          '  1  - $1 lobby',
          '  5  - $5 lobby',
          '  20 - $20 lobby',
          '',
          'Region:',
          '  us - US servers',
          '  eu - EU servers',
          '',
          'Examples:',
          '  ,lb 1 us',
          '  ,lb 5 eu',
          '  ,lb 20 us',
          '',
          'Notes:',
          '  • Players with size = 0 are ignored',
          '  • Shows USD value converted from SOL',
          '',
          solPriceStatusLine()
        ].join('\n')
      )
      .setColor(0x00AEFF);
    await message.reply({ embeds: [embed] });
    return;
  }

  const lobbyNum = parseInt(args[0], 10);
  const region = (args[1] || '').toLowerCase();

  if (![1, 5, 20].includes(lobbyNum)) {
    await message.reply(
      'Invalid lobby. Lobby must be 1, 5, or 20.\nUsage: `,lb <lobby> <region>`\nExample: `,lb 5 us`'
    );
    return;
  }
  if (!['us', 'eu'].includes(region)) {
    await message.reply(
      'Invalid region. Region must be "us" or "eu".\nUsage: `,lb <lobby> <region>`\nExample: `,lb 5 us`'
    );
    return;
  }

  const lobbyDef = findLobby(region, lobbyNum);
  if (!lobbyDef) {
    await message.reply('Could not find that lobby definition.');
    return;
  }

  const snapshot = await getLobbySnapshot(lobbyDef);
  if (!snapshot) {
    await message.reply(
      'Could not load lobby data right now. The game server might be offline or unreachable. Please try again in a moment.'
    );
    return;
  }

  const players = snapshot.players
    .filter(p => typeof p.size === 'number' && p.size > 0)
    .sort((a, b) => (b.size || 0) - (a.size || 0));

  const embed = new EmbedBuilder()
    .setTitle(`${lobbyDef.label} Lobby Leaderboard`)
    .setColor(0x00ff88);

  const headerLines = [
    `Lobby: $${lobbyDef.lobby}   Region: ${lobbyDef.region.toUpperCase()}`,
    `Players in lobby: ${snapshot.playerCount}`,
    solPriceStatusLine(),
    `Data pulled: ${new Date(snapshot.lastFetched || Date.now()).toISOString()}`
  ];

  if (players.length === 0) {
    embed.setDescription(headerLines.join('\n') + '\n\nNo active players with size > 0.');
  } else {
    embed.setDescription(headerLines.join('\n'));
    players.slice(0, 25).forEach((p, index) => {
      const rank = index + 1;
      const name = p.name || p.privyId || p.id || 'Unknown';
      const usdDisplay =
        typeof p.usdFromSol === 'number'
          ? `$${p.usdFromSol.toFixed(4)}`
          : '(price unavailable)';
      embed.addFields({
        name: `#${rank} ${name}`,
        value: `Size: ${p.size.toFixed(2)}\nUSD: ${usdDisplay}`,
        inline: false
      });
    });
    embed.setFooter({ text: 'Players with size = 0 are hidden' });
  }

  await message.reply({ embeds: [embed] });
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
          '',
          'Lobby:',
          '  1  - $1 lobby',
          '  5  - $5 lobby',
          '  20 - $20 lobby',
          '',
          'Region:',
          '  us - US servers',
          '  eu - EU servers',
          '',
          'Examples:',
          '  ,alert on 20 us',
          '  ,alert off 5 eu',
          '  ,alert channel #damnbruh-alerts',
          '  ,alert list',
          ''
        ].join('\n')
      )
      .setFooter({ text: 'Alerts ping when someone joins that lobby' })
      .setColor(0x00AEFF);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'channel') {
    const channel = message.mentions.channels.first();
    if (!channel || !channel.isTextBased()) {
      await message.reply(
        'Please mention a text channel. Example: `,alert channel #damnbruh-alerts`'
      );
      return;
    }
    cfg.alertChannelId = channel.id;
    await message.reply(
      `Alert channel set to ${channel}. Join and watch alerts will be sent here.`
    );
    return;
  }

  if (sub === 'on' || sub === 'off') {
    if (args.length < 3) {
      await message.reply(
        'Invalid arguments.\nUsage: `,alert on <lobby> <region>`\nExample: `,alert on 20 us`'
      );
      return;
    }
    const lobbyNum = parseInt(args[1], 10);
    const region = (args[2] || '').toLowerCase();

    if (![1, 5, 20].includes(lobbyNum) || !['us', 'eu'].includes(region)) {
      await message.reply(
        'Invalid arguments.\nLobby must be 1, 5, or 20.\nRegion must be "us" or "eu".\n\nExample: `,alert on 20 us`'
      );
      return;
    }

    if (sub === 'on') {
      if (!cfg.alertChannelId) {
        await message.reply('Alert channel is not set. Use `,alert channel #channel` first.');
        return;
      }
      const key = getLobbyKey(region, lobbyNum);
      cfg.alertEnabled[key] = true;
      if (!cfg.lastSeenPlayers[key]) {
        cfg.lastSeenPlayers[key] = new Set();
      }
      await message.reply(
        `Join alerts enabled for ${region.toUpperCase()} $${lobbyNum} lobby in <#${cfg.alertChannelId}>.`
      );
    } else {
      const key = getLobbyKey(region, lobbyNum);
      if (!cfg.alertEnabled[key]) {
        await message.reply(
          `Join alerts are already disabled for ${region.toUpperCase()} $${lobbyNum} lobby.`
        );
        return;
      }
      cfg.alertEnabled[key] = false;
      cfg.lastSeenPlayers[key] = new Set();
      await message.reply(
        `Join alerts disabled for ${region.toUpperCase()} $${lobbyNum} lobby.`
      );
    }
    return;
  }

  if (sub === 'list') {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const usLines = [];
    const euLines = [];
    for (const lobby of LOBBIES) {
      const state = cfg.alertEnabled[lobby.key] ? 'ON' : 'OFF';
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
      .setColor(0xCCCCCC);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'status') {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const enabled = [];
    for (const lobby of LOBBIES) {
      if (cfg.alertEnabled[lobby.key]) {
        enabled.push(`$${lobby.lobby} ${lobby.region.toUpperCase()}`);
      }
    }
    const enabledText = enabled.length ? enabled.join(', ') : 'none';

    await message.reply(
      [
        `Alert channel: ${channelText}`,
        'Join alerts enabled on:',
        `  ${enabledText}`
      ].join('\n')
    );
    return;
  }

  await message.reply(
    'Unknown subcommand.\nUsage: `,alert on|off <lobby> <region>`, `,alert channel #channel`, `,alert list`, `,alert status`'
  );
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
          '',
          'Lobby:',
          '  1  - $1 lobby',
          '  5  - $5 lobby',
          '  20 - $20 lobby',
          '',
          'Region:',
          '  us - US servers',
          '  eu - EU servers',
          '',
          'Threshold:',
          '  Minimum number of players needed to trigger the alert.',
          '',
          'Minutes:',
          '  How often to send alerts while threshold is met.',
          '  Minimum is 1 minute. There is no max.',
          '',
          'Examples:',
          '  ,watch add 5 us 6 2',
          '  ,watch list',
          '  ,watch remove 1',
          '  ,watch clear'
        ].join('\n')
      )
      .setColor(0x00AEFF);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'add') {
    if (args.length < 5) {
      await message.reply(
        'Invalid arguments.\nUsage: `,watch add <lobby> <region> <threshold> <minutes>`\nExample: `,watch add 5 us 6 2`'
      );
      return;
    }
    const lobbyNum = parseInt(args[1], 10);
    const region = (args[2] || '').toLowerCase();
    const threshold = parseInt(args[3], 10);
    const minutes = parseInt(args[4], 10);

    if (![1, 5, 20].includes(lobbyNum) || !['us', 'eu'].includes(region)) {
      await message.reply(
        'Invalid arguments.\nLobby must be 1, 5, or 20.\nRegion must be "us" or "eu".\n\nExample: `,watch add 5 us 6 2`'
      );
      return;
    }
    if (!Number.isInteger(threshold) || threshold < 1) {
      await message.reply(
        'Threshold must be a whole number of players and at least 1.\nExample: `,watch add 5 us 6 2`'
      );
      return;
    }
    if (!Number.isInteger(minutes) || minutes < 1) {
      await message.reply(
        'Minutes must be a whole number and at least 1.\nExample: `,watch add 5 us 6 2`'
      );
      return;
    }

    const lobbyDef = findLobby(region, lobbyNum);
    if (!lobbyDef) {
      await message.reply('Could not find that lobby definition.');
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

    await message.reply(
      [
        'Watch created.',
        '',
        `Lobby: ${lobbyDef.label}`,
        `Threshold: ${threshold} players`,
        `Interval: ${minutes} minute(s)`,
        `Watch ID: ${id}`
      ].join('\n')
    );
    return;
  }

  if (sub === 'list') {
    if (cfg.watches.size === 0) {
      await message.reply(
        'There are no active watches in this server.\nUse `,watch add <lobby> <region> <threshold> <minutes>` to create one.'
      );
      return;
    }

    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const embed = new EmbedBuilder()
      .setTitle('Active Lobby Watches')
      .setDescription(`Alert channel: ${channelText}`)
      .setColor(0xCCCCCC);

    for (const [id, watch] of cfg.watches.entries()) {
      const lobbyDef = LOBBIES.find(l => l.key === watch.lobbyKey);
      const lobbyLabel = lobbyDef ? lobbyDef.label : watch.lobbyKey;
      const last = watch.lastAlertAt
        ? watch.lastAlertAt.toISOString()
        : 'never';
      embed.addFields({
        name: `ID ${id} - ${lobbyLabel}`,
        value: `Threshold: ${watch.threshold} players\nInterval: ${watch.intervalMinutes} minute(s)\nLast alert: ${last}`,
        inline: false
      });
    }

    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'remove') {
    if (args.length < 2) {
      await message.reply('Usage: `,watch remove <id>`');
      return;
    }
    const id = parseInt(args[1], 10);
    if (!cfg.watches.has(id)) {
      await message.reply(
        `No watch found with ID ${id}.\nUse \`,watch list\` to see all active watches.`
      );
      return;
    }
    cfg.watches.delete(id);
    await message.reply(`Watch ${id} removed.`);
    return;
  }

  if (sub === 'clear') {
    if (cfg.watches.size === 0) {
      await message.reply('There are no watches to clear.');
      return;
    }
    cfg.watches.clear();
    await message.reply('All watches have been cleared for this server.');
    return;
  }

  await message.reply(
    'Unknown subcommand.\nUsage: `,watch add`, `,watch list`, `,watch remove`, `,watch clear`'
  );
}

// ----- ,config command (optional simple default-region) -----
async function handleConfigCommand(message, args) {
  const guildId = message.guild.id;
  const cfg = getGuildConfig(guildId);

  const sub = (args[0] || '').toLowerCase();

  if (!sub) {
    const channelText = cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'not set';
    const defaultRegion = cfg.defaultRegion || 'not set';
    const embed = new EmbedBuilder()
      .setTitle('Bot Configuration')
      .setDescription(
        [
          `Default region: ${defaultRegion}`,
          `Alert channel: ${channelText}`,
          '',
          'Commands:',
          '  ,config default-region <us|eu>',
          '  ,alert channel #channel'
        ].join('\n')
      )
      .setColor(0xCCCCCC);
    await message.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'default-region') {
    const region = (args[1] || '').toLowerCase();
    if (!['us', 'eu'].includes(region)) {
      await message.reply(
        'Invalid region. Region must be "us" or "eu".\nExample: `,config default-region us`'
      );
      return;
    }
    cfg.defaultRegion = region;
    await message.reply(`Default region set to ${region.toUpperCase()}.`);
    return;
  }

  await message.reply(
    'Unknown subcommand.\nUsage: `,config default-region <us|eu>`'
  );
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

    for (const lobby of LOBBIES) {
      const key = lobby.key;
      if (!cfg.alertEnabled[key]) continue;

      const snapshot = lobbyCache.get(key);
      if (!snapshot || !Array.isArray(snapshot.players)) continue;

      const currentIds = new Set(
        snapshot.players.map(p => p.privyId || p.id).filter(Boolean)
      );

      if (!cfg.lastSeenPlayers[key]) {
        cfg.lastSeenPlayers[key] = new Set();
      }
      const lastSet = cfg.lastSeenPlayers[key];

      const newJoins = [];
      for (const id of currentIds) {
        if (!lastSet.has(id)) {
          const player = snapshot.players.find(
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
        await channel.send(
          `${name} joined ${lobby.region.toUpperCase()} $${lobby.lobby} lobby. Lobby players: ${snapshot.playerCount}.`
        );
      } else {
        const names = newJoins
          .map(p => p.name || p.privyId || p.id || 'Unknown')
          .map(n => `• ${n}`)
          .join('\n');
        await channel.send(
          [
            `New joins in ${lobby.region.toUpperCase()} $${lobby.lobby} lobby:`,
            names,
            `Lobby players: ${snapshot.playerCount}.`
          ].join('\n')
        );
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

    for (const [id, watch] of cfg.watches.entries()) {
      const lobbyDef = LOBBIES.find(l => l.key === watch.lobbyKey);
      if (!lobbyDef) continue;

      const snapshot = lobbyCache.get(watch.lobbyKey);
      if (!snapshot) continue;

      const playerCount = snapshot.playerCount || 0;
      if (playerCount < watch.threshold) continue;

      const intervalMs = watch.intervalMinutes * 60 * 1000;
      const lastMs = watch.lastAlertAt ? watch.lastAlertAt.getTime() : 0;

      if (!watch.lastAlertAt || now - lastMs >= intervalMs) {
        await channel.send(
          [
            `${lobbyDef.region.toUpperCase()} $${lobbyDef.lobby} lobby has ${playerCount} players.`,
            `Threshold: ${watch.threshold}. Interval: ${watch.intervalMinutes} minute(s).`,
            `(Watch ID ${id})`
          ].join('\n')
        );
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
