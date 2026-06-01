console.log('\x1b[36m%s\x1b[0m', `
##############################################
#                                            #
#   __  __   _____  __          __   _____   #
#  |  \\/  | / ____| \\ \\        / /  / ____|  #
#  | \\  / | | |       \\ \\  /\\  / /  | (___    #
#  | |\\/| | | |        \\ \\/  \\/ /    \\___ \\   #
#  | |  | | | |____     \\  /\\  /     ____) |  #
#  |_|  |_|  \\_____|     \\/  \\/     |_____/   #
#                                            #
#            -- by IhmHika --               #
#                                            #
##############################################
`);

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActivityType } = require('discord.js');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');

let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const { TOKEN, WSS_PORT, ADMIN_IDS } = config;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let wss = null;
let mcConnection = null;
let currentPlayers = [];
let maxPlayers = "0";
let worldName = "Minecraft World";
let isInitialSync = true;

const messageCache = new Set();

const getMemos = () => JSON.parse(fs.readFileSync('./memos.json', 'utf8'));
const saveMemos = (m) => fs.writeFileSync('./memos.json', JSON.stringify(m, null, 2), 'utf8');
if (!fs.existsSync('./memos.json')) fs.writeFileSync('./memos.json', '[]', 'utf8');

function saveLog(text) {
    const now = new Date();
    const timeStr = `[${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}]`;
    fs.appendFileSync('./log.txt', `${timeStr} ${text}\n`, 'utf8');
}

function stopServer() {
    if (mcConnection) { mcConnection.terminate(); mcConnection = null; }
    if (wss) { wss.close(); wss = null; }
    updateStatus();
}

const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start WebSocket server'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop WebSocket server'),
    new SlashCommandBuilder().setName('list').setDescription('Show online players'),
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    new SlashCommandBuilder().setName('help').setDescription('Show command reference'),
    new SlashCommandBuilder().setName('info').setDescription('Show system status'),
    new SlashCommandBuilder()
        .setName('channel')
        .setDescription('Configure sync channel')
        .addStringOption(o => o.setName('action').setDescription('Select action').setRequired(true)
            .addChoices({ name: 'Set', value: 'set' }, { name: 'Remove', value: 'remove' })),
    new SlashCommandBuilder()
        .setName('memo')
        .setDescription('Coordinate memo management')
        .addSubcommand(sub => sub.setName('add').setDescription('Add a new memo')
            .addStringOption(o => o.setName('title').setDescription('Memo title').setRequired(true))
            .addStringOption(o => o.setName('coords').setDescription('x y z').setRequired(true))
            .addStringOption(o => o.setName('dim').setDescription('Dimension').setRequired(true)
                .addChoices({ name: 'Overworld', value: 'Overworld' }, { name: 'Nether', value: 'Nether' }, { name: 'The End', value: 'The End' })))
        .addSubcommand(sub => sub.setName('view').setDescription('View all memos'))
        .addSubcommand(sub => sub.setName('delete').setDescription('Delete a memo')
            .addIntegerOption(o => o.setName('id').setDescription('Memo ID').setRequired(true))),
    new SlashCommandBuilder()
        .setName('log')
        .setDescription('Access system logs')
        .addStringOption(o => o.setName('action').setDescription('Select action').setRequired(true)
            .addChoices({ name: 'View', value: 'view' }, { name: 'Clear', value: 'clear' })),
    new SlashCommandBuilder()
        .setName('command')
        .setDescription('Send command to Minecraft')
        .addStringOption(o => o.setName('cmd').setDescription('Minecraft command').setRequired(true)),
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Log in: ${client.user.tag}`);
    const guildId = config.GUILD_ID || client.guilds.cache.first()?.id;
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
            console.log('Commands successfully reloaded.');
        }
    } catch (e) { console.error(e); }
    updateStatus();
});

function updateStatus() {
    client.user.setActivity(mcConnection ? `${worldName} (${currentPlayers.length}/${maxPlayers})` : 'Offline', { type: ActivityType.Playing });
}

function sendMCCommand(ws, command, requestId) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ header: { version: 1, requestId: requestId, messageType: "commandRequest", messagePurpose: "commandRequest" }, body: { commandLine: command, version: 1 } }));
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') return await interaction.reply({ content: `Latency: ${client.ws.ping}ms`, ephemeral: true });

    if (interaction.commandName === 'help') {
        const helpEmbed = new EmbedBuilder().setTitle("Command Reference").setColor(0x2b2d31)
            .addFields(
                { name: "System", value: "`/start` - Start WebSocket\n`/stop` - Stop WebSocket\n`/channel` - Config channel\n`/info` - System status\n`/ping` - Check latency" },
                { name: "Minecraft", value: "`/list` - Online players\n`/command` - Send command" },
                { name: "Utility", value: "`/memo` - Manage coordinates\n`/log` - View/Clear logs" }
            ).setFooter({ text: "MCWS | Developed by IhmHika" });
        return await interaction.reply({ embeds: [helpEmbed] });
    }

    if (interaction.commandName === 'info') {
        const status = mcConnection ? "Connected" : "Disconnected";
        const infoEmbed = new EmbedBuilder().setTitle("System Status").setColor(mcConnection ? 0x2ecc71 : 0xe74c3c)
            .addFields(
                { name: "Connection", value: status, inline: true },
                { name: "Players", value: `${currentPlayers.length} / ${maxPlayers}`, inline: true },
                { name: "Uptime", value: `${Math.floor(process.uptime() / 60)} min`, inline: true }
            );
        return await interaction.reply({ embeds: [infoEmbed] });
    }

    if (interaction.commandName === 'channel') {
        if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: 'No permission', ephemeral: true });
        const action = interaction.options.getString('action');
        if (action === 'set') {
            config.CHANNEL_ID = interaction.channelId;
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription(`Channel <#${interaction.channelId}> set.`).setColor(0x3498db)] });
        } else if (action === 'remove') {
            config.CHANNEL_ID = "";
            fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('Channel setting removed.').setColor(0xe67e22)] });
        }
    }
    if (interaction.commandName === 'start') {
        if (!config.CHANNEL_ID) return interaction.reply({ content: 'Channel not set.', ephemeral: true });
        if (wss) return interaction.reply({ content: 'Already running', ephemeral: true });
        wss = new WebSocketServer({ port: WSS_PORT });
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Server Started').setColor(0x3498db).setDescription(`Port: ${WSS_PORT}`)] });

        wss.on('connection', (ws) => {
            mcConnection = ws; isInitialSync = true;
            const channel = client.channels.cache.get(config.CHANNEL_ID);
            channel?.send({ embeds: [new EmbedBuilder().setTitle('World Connected').setColor(0x2ecc71)] });

            ["PlayerMessage", "Text", "ChatMessage"].forEach(ev => {
                ws.send(JSON.stringify({ header: { version: 1, requestId: crypto.randomUUID(), messageType: "commandRequest", messagePurpose: "subscribe" }, body: { eventName: ev } }));
            });

            const monitor = setInterval(() => {
                if (ws.readyState !== 1) return clearInterval(monitor);
                sendMCCommand(ws, "list", "sync-list");
            }, 500);

            ws.on('message', (data) => {
                try {
                    const { header, body } = JSON.parse(data);
                    const channel = client.channels.cache.get(config.CHANNEL_ID);
                    const eventName = header?.eventName || "";
                    const isChatEvent = eventName === "PlayerMessage" || eventName === "ChatMessage";
                    const isTextEvent = eventName === "Text";

                    if (header.requestId === "sync-list") {
                        const m = body.statusMessage?.match(/(\d+)\/(\d+)/);
                        if (m) maxPlayers = m[2];
                        const newP = body.statusMessage?.split(/:\s*/)[1]?.split(', ').map(n => n.trim()).filter(n => n !== "") || [];
                        if (!isInitialSync) {
                            newP.forEach(p => { if (!currentPlayers.includes(p)) channel?.send({ embeds: [new EmbedBuilder().setDescription(`**${p}** join (${newP.length}/${maxPlayers})`).setColor(0x57f287)] }); });
                            currentPlayers.forEach(p => { if (!newP.includes(p)) channel?.send({ embeds: [new EmbedBuilder().setDescription(`**${p}** left (${newP.length}/${maxPlayers})`).setColor(0xed4245)] }); });
                        }
                        currentPlayers = newP; isInitialSync = false; updateStatus();
                        return;
                    }

                    let rawMsg = body.message || body.properties?.Message || "";
                    if (rawMsg.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(rawMsg);
                            if (parsed.hasOwnProperty('rawtext')) return;
                        } catch (e) { }
                    }
                    let cleanMsg = rawMsg.replace(/\u00A7./g, "").trim();

                    if (!cleanMsg || cleanMsg.includes('[Discord]') || cleanMsg.startsWith('/')) return;
                    if (!isChatEvent && !isTextEvent) return;
                    if (/[\r\n]/.test(cleanMsg)) return;
                    const isJoin = cleanMsg.includes("joined the game") || cleanMsg.includes("Join:");
                    const isLeft = cleanMsg.includes("left the game") || cleanMsg.includes("Left:");
                    if (isJoin || isLeft) {
                        const embed = new EmbedBuilder().setDescription(`**${cleanMsg}**`).setColor(isJoin ? 0x57F287 : 0xED4245);
                        channel?.send({ embeds: [embed] });
                        return;
                    }

                    let sender = "";
                    let content = "";
                    const bracketChat = cleanMsg.match(/^<(.+?)>\s+(.+)$/);
                    if (bracketChat) {
                        sender = bracketChat[1].trim();
                        content = bracketChat[2].trim();
                    } else {
                        const jpChat = cleanMsg.match(/^<(.+?)>\s*\(チャット\)\s*(.+)$/);
                        if (jpChat) {
                            sender = jpChat[1].trim();
                            content = jpChat[2].trim();
                        }
                    }

                    // Fallback for normal chat events where sender/message are separated in the payload.
                    if ((!sender || !content) && (isChatEvent || isTextEvent)) {
                        const bodySender = (body.sender || body.properties?.Sender || "").trim();
                        const bodyMessage = (body.message || body.properties?.Message || "").trim();
                        if (bodySender && bodyMessage) {
                            sender = bodySender;
                            content = bodyMessage.replace(/^<(.+?)>\s*/, "").trim();
                        } else if (bodySender && cleanMsg) {
                            sender = bodySender;
                            content = cleanMsg.replace(/^<(.+?)>\s*/, "").trim();
                        }
                    }

                    if (!sender || !content) return;

                    const cacheKey = `${sender}:${content}`;
                    if (messageCache.has(cacheKey)) return;
                    messageCache.add(cacheKey);
                    setTimeout(() => messageCache.delete(cacheKey), 1500);

                    channel?.send(`<${sender}> ${content}`);
                    saveLog(`[MC] <${sender}> ${content}`);

                } catch (e) { }
            });

            ws.on('close', () => {
                const channel = client.channels.cache.get(config.CHANNEL_ID);
                if (mcConnection) { mcConnection = null; updateStatus(); channel?.send({ embeds: [new EmbedBuilder().setTitle('Disconnected').setColor(0x992d22)] }); }
            });
        });
    }
    if (interaction.commandName === 'stop') { stopServer(); await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Stopped').setColor(0x34495e)] }); }

    if (interaction.commandName === 'list') {
        if (!mcConnection) return interaction.reply('Not connected');
        await interaction.deferReply();
        sendMCCommand(mcConnection, "list", "sync-list");
        setTimeout(async () => {
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`Online: (${currentPlayers.length}/${maxPlayers})`).setDescription(currentPlayers.join('\n') || 'None').setColor(0x2b2d31)] });
        }, 800);
    }

    if (interaction.commandName === 'memo') {
        const sub = interaction.options.getSubcommand();
        let memos = getMemos();
        if (sub === 'add') {
            const m = { title: interaction.options.getString('title'), coords: interaction.options.getString('coords'), dim: interaction.options.getString('dim'), author: interaction.user.username, date: new Date().toLocaleDateString('ja-JP') };
            memos.push(m); saveMemos(memos);
            await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Memo Saved').setDescription(`${m.title} | ${m.coords} (${m.dim})`).setColor(0x2ecc71)] });
        } else if (sub === 'view') {
            if (memos.length === 0) return interaction.reply('No memos recorded.');
            const embed = new EmbedBuilder().setTitle('Coordinate Memos').setColor(0x2b2d31);
            memos.forEach((m, i) => embed.addFields({ name: `ID: ${i} | ${m.title}`, value: `${m.coords} (${m.dim})` }));
            await interaction.reply({ embeds: [embed] });
        } else if (sub === 'delete') {
            const id = interaction.options.getInteger('id');
            if (id < 0 || id >= memos.length) return interaction.reply('Invalid ID');
            memos.splice(id, 1); saveMemos(memos);
            await interaction.reply({ embeds: [new EmbedBuilder().setDescription('Memo deleted.').setColor(0xe74c3c)] });
        }
    }

    if (interaction.commandName === 'log') {
        if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply('No permission');
        const action = interaction.options.getString('action');
        if (action === 'view') {
            if (!fs.existsSync('./log.txt')) return interaction.reply('No logs found.');
            const data = fs.readFileSync('./log.txt', 'utf8').split('\n').filter(l => l.length > 0);
            await interaction.reply({ embeds: [new EmbedBuilder().setTitle('System Logs').setDescription(`\`\`\`\n${data.slice(-15).join('\n')}\n\`\`\``).setColor(0x2b2d31)] });
        } else if (action === 'clear') { fs.writeFileSync('./log.txt', '', 'utf8'); await interaction.reply({ embeds: [new EmbedBuilder().setDescription('Logs cleared.').setColor(0x95a5a6)] }); }
    }

    if (interaction.commandName === 'command') {
        if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply('No permission');
        if (!mcConnection) return interaction.reply('Not connected');
        const cmd = interaction.options.getString('cmd');
        sendMCCommand(mcConnection, cmd, crypto.randomUUID());
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle('Command Sent').setDescription(`/${cmd}`).setColor(0xf1c40f)] });
    }
});

client.on('messageCreate', (msg) => {
    if (msg.author.bot || msg.channel.id !== config.CHANNEL_ID || !mcConnection || msg.content.startsWith('/')) return;
    saveLog(`[DISCORD] <${msg.author.username}> ${msg.content}`);
    mcConnection.send(JSON.stringify({ header: { version: 1, requestId: crypto.randomUUID(), messageType: "commandRequest", messagePurpose: "commandRequest" }, body: { commandLine: `tellraw @a {"rawtext":[{"text":"§b[Discord] §r<${msg.author.username}> ${msg.content}"}]}`, version: 1 } }));
});

client.login(TOKEN);
