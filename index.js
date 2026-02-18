require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  ADMIN_ROLE_ID,
  SALES_CATEGORY_ID,
} = process.env;

if (!DISCORD_TOKEN) throw new Error("Faltou DISCORD_TOKEN nas variáveis.");
if (!CLIENT_ID) throw new Error("Faltou CLIENT_ID nas variáveis.");
if (!GUILD_ID) throw new Error("Faltou GUILD_ID nas variáveis.");
if (!ADMIN_ROLE_ID) throw new Error("Faltou ADMIN_ROLE_ID nas variáveis.");
if (!SALES_CATEGORY_ID) throw new Error("Faltou SALES_CATEGORY_ID nas variáveis.");

const DB_PATH = path.join(__dirname, "db.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify(
        {
          products: [],
          pix: {
            key: "",
            name: "",
            city: "",
            qrUrl: "" // link da imagem do QR
          },
        },
        null,
        2
      )
    );
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator) || member.roles.cache.has(ADMIN_ROLE_ID);
}

// Carrinhos em memória (suficiente pra uso normal)
const carts = new Map(); // userId -> Map(productId -> qty)

function getCart(userId) {
  if (!carts.has(userId)) carts.set(userId, new Map());
  return carts.get(userId);
}

function formatBRL(n) {
  return `R$ ${Number(n).toFixed(2)}`;
}

function cartSummary(db, userId) {
  const cart = getCart(userId);
  let total = 0;
  const lines = [];

  for (const [pid, qty] of cart.entries()) {
    const p = db.products.find(x => x.id === pid && x.active);
    if (!p) continue;
    const sub = p.price * qty;
    total += sub;
    lines.push(`• **${p.name}** x${qty} — ${formatBRL(sub)}`);
  }

  if (lines.length === 0) return { text: "Seu carrinho está vazio.", total: 0 };
  return { text: lines.join("\n") + `\n\n**Total:** ${formatBRL(total)}`, total };
}

// ===== UI =====
function buildPanelEmbed(imageUrl) {
  const embed = new EmbedBuilder()
    .setTitle("🛒 Loja")
    .setDescription(
      [
        "Clique em **Comprar** para selecionar produtos e montar seu carrinho.",
        "Depois finalize e o bot cria um **ticket privado** com o **PIX (chave + QR)**.",
      ].join("\n")
    )
    .setFooter({ text: "Atendimento rápido • Pagamento via PIX" });

  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

function buildPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_menu")
        .setLabel("Comprar")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🛒"),
      new ButtonBuilder()
        .setCustomId("view_cart")
        .setLabel("Ver carrinho")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🧾")
    ),
  ];
}

function buildProductMenu(db, ownerId) {
  const active = db.products.filter(p => p.active);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`add_to_cart:${ownerId}`)
    .setPlaceholder(active.length ? "Escolha um produto" : "Sem produtos cadastrados");

  if (active.length) {
    menu.addOptions(
      active.slice(0, 25).map(p => ({
        label: `${p.name} — ${formatBRL(p.price)}`,
        value: p.id
      }))
    );
  } else {
    menu.addOptions([{ label: "Nenhum produto disponível", value: "none" }]);
    menu.setDisabled(true);
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildCartButtons(ownerId, canCheckout) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_more:${ownerId}`)
      .setLabel("Adicionar mais")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➕"),
    new ButtonBuilder()
      .setCustomId(`clear_cart:${ownerId}`)
      .setLabel("Esvaziar")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑️"),
    new ButtonBuilder()
      .setCustomId(`checkout:${ownerId}`)
      .setLabel("Finalizar")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(!canCheckout)
  );
}

function buildConfirmButtons(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_order:${ownerId}`)
      .setLabel("Confirmar compra")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`cancel_order:${ownerId}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("↩️")
  );
}

function buildTicketButtons(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`paid:${ownerId}`)
      .setLabel("Já paguei")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💸"),
    new ButtonBuilder()
      .setCustomId(`close:${ownerId}`)
      .setLabel("Fechar ticket")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔒")
  );
}

// ===== Slash Commands =====
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("painel")
      .setDescription("Posta o painel da loja (com imagem opcional).")
      .addAttachmentOption(o =>
        o.setName("imagem").setDescription("Envie/Anexe a imagem do painel (opcional).").setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("produto")
      .setDescription("Gerenciar produtos")
      .addSubcommand(s =>
        s.setName("adicionar")
          .setDescription("Adicionar produto (admin)")
          .addStringOption(o => o.setName("nome").setDescription("Nome").setRequired(true))
          .addNumberOption(o => o.setName("preco").setDescription("Preço (ex: 19.90)").setRequired(true))
      )
      .addSubcommand(s =>
        s.setName("listar").setDescription("Listar produtos")
      )
      .addSubcommand(s =>
        s.setName("remover")
          .setDescription("Remover/desativar produto (admin)")
          .addStringOption(o => o.setName("id").setDescription("ID do produto").setRequired(true))
      ),

    new SlashCommandBuilder()
      .setName("pix")
      .setDescription("Configurar PIX (admin)")
      .addStringOption(o => o.setName("chave").setDescription("Chave PIX").setRequired(true))
      .addStringOption(o => o.setName("nome").setDescription("Nome do recebedor").setRequired(true))
      .addStringOption(o => o.setName("cidade").setDescription("Cidade").setRequired(true))
      .addAttachmentOption(o => o.setName("qr").setDescription("Anexe a imagem do QR Code (opcional)").setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
}

// ===== Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  await registerCommands();
  console.log(`✅ Logado como ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  const db = loadDB();

  // Slash commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "painel") {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: "❌ Só admins podem usar /painel.", ephemeral: true });
      }
      const att = interaction.options.getAttachment("imagem");
      const imageUrl = att?.url || null;

      return interaction.reply({
        embeds: [buildPanelEmbed(imageUrl)],
        components: buildPanelButtons(),
      });
    }

    if (interaction.commandName === "pix") {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: "❌ Só admins podem configurar PIX.", ephemeral: true });
      }
      const chave = interaction.options.getString("chave");
      const nome = interaction.options.getString("nome");
      const cidade = interaction.options.getString("cidade");
      const qr = interaction.options.getAttachment("qr");

      db.pix.key = chave;
      db.pix.name = nome;
      db.pix.city = cidade;
      db.pix.qrUrl = qr?.url || db.pix.qrUrl || "";
      saveDB(db);

      return interaction.reply({
        content: `✅ PIX configurado.\n• Chave: \`${db.pix.key}\`\n• Nome: ${db.pix.name}\n• Cidade: ${db.pix.city}\n• QR: ${db.pix.qrUrl ? "OK" : "Não definido"}`,
        ephemeral: true
      });
    }

    if (interaction.commandName === "produto") {
      const sub = interaction.options.getSubcommand();

      if (sub === "adicionar") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: "❌ Só admins podem adicionar produtos.", ephemeral: true });
        }
        const name = interaction.options.getString("nome");
        const price = interaction.options.getNumber("preco");

        const id = `p_${Date.now()}`;
        db.products.push({ id, name, price, active: true });
        saveDB(db);

        return interaction.reply({ content: `✅ Produto adicionado: **${name}** (${formatBRL(price)})\nID: \`${id}\`` });
      }

      if (sub === "listar") {
        const active = db.products.filter(p => p.active);
        if (!active.length) return interaction.reply({ content: "📦 Nenhum produto cadastrado.", ephemeral: true });

        const embed = new EmbedBuilder().setTitle("📦 Produtos");
        active.forEach(p => embed.addFields({ name: `${p.name} — ${formatBRL(p.price)}`, value: `ID: \`${p.id}\`` }));

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === "remover") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: "❌ Só admins podem remover produtos.", ephemeral: true });
        }
        const id = interaction.options.getString("id");
        const p = db.products.find(x => x.id === id);
        if (!p) return interaction.reply({ content: "❌ Produto não encontrado.", ephemeral: true });
        p.active = false;
        saveDB(db);
        return interaction.reply({ content: `🗑️ Produto desativado: **${p.name}**`, ephemeral: true });
      }
    }

    return;
  }

  // Buttons
  if (interaction.isButton()) {
    const cid = interaction.customId;

    if (cid === "open_menu") {
      return interaction.reply({
        content: "Selecione um produto para adicionar ao carrinho:",
        components: [buildProductMenu(db, interaction.user.id)],
        ephemeral: true,
      });
    }

    if (cid === "view_cart") {
      const sum = cartSummary(db, interaction.user.id);
      return interaction.reply({
        content: `🧾 **Seu carrinho:**\n${sum.text}`,
        components: [buildCartButtons(interaction.user.id, sum.total > 0)],
        ephemeral: true,
      });
    }

    const [action, ownerId] = cid.split(":");

    // Protege ações do carrinho/ticket
    const protectedActions = new Set(["add_more", "clear_cart", "checkout", "confirm_order", "cancel_order", "paid", "close"]);
    if (protectedActions.has(action) && ownerId !== interaction.user.id) {
      return interaction.reply({ content: "❌ Isso não é pra você.", ephemeral: true });
    }

    if (action === "add_more") {
      return interaction.reply({
        content: "Escolha mais um produto:",
        components: [buildProductMenu(db, interaction.user.id)],
        ephemeral: true,
      });
    }

    if (action === "clear_cart") {
      getCart(interaction.user.id).clear();
      return interaction.update({
        content: "🗑️ Carrinho esvaziado.",
        components: [buildCartButtons(interaction.user.id, false)]
      });
    }

    if (action === "checkout") {
      const sum = cartSummary(db, interaction.user.id);
      const embed = new EmbedBuilder()
        .setTitle("✅ Revisar pedido")
        .setDescription(sum.text);

      return interaction.reply({
        embeds: [embed],
        components: [buildConfirmButtons(interaction.user.id)],
        ephemeral: true,
      });
    }

    if (action === "cancel_order") {
      return interaction.update({ content: "Compra cancelada.", embeds: [], components: [] });
    }

    if (action === "confirm_order") {
      // Verifica PIX configurado
      if (!db.pix.key || !db.pix.name || !db.pix.city) {
        return interaction.reply({ content: "❌ Loja sem PIX configurado. Admin use /pix.", ephemeral: true });
      }

      const sum = cartSummary(db, interaction.user.id);
      if (sum.total <= 0) return interaction.reply({ content: "Seu carrinho está vazio.", ephemeral: true });

      // cria ticket privado
      const guild = interaction.guild;
      const category = guild.channels.cache.get(SALES_CATEGORY_ID);
      if (!category) return interaction.reply({ content: "❌ SALES_CATEGORY_ID inválido.", ephemeral: true });

      const ticketName = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const channel = await guild.channels.create({
        name: ticketName.slice(0, 90),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
      });

      const payEmbed = new EmbedBuilder()
        .setTitle("💳 Pagamento via PIX")
        .setDescription(
          `Olá <@${interaction.user.id}>! ✅\n\n` +
          `**Itens:**\n${sum.text}\n\n` +
          `**PIX (copia e cola):**\n` +
          `• **Chave:** \`${db.pix.key}\`\n` +
          `• **Nome:** ${db.pix.name}\n` +
          `• **Cidade:** ${db.pix.city}\n\n` +
          `📌 Depois de pagar, clique em **Já paguei**.`
        );

      if (db.pix.qrUrl) payEmbed.setImage(db.pix.qrUrl);

      await channel.send({
        content: `<@&${ADMIN_ROLE_ID}> novo pedido de <@${interaction.user.id}>`,
        embeds: [payEmbed],
        components: [buildTicketButtons(interaction.user.id)],
      });

      // limpa carrinho
      getCart(interaction.user.id).clear();

      return interaction.update({
        content: `✅ Ticket criado: <#${channel.id}>`,
        embeds: [],
        components: [],
      });
    }

    if (action === "paid") {
      await interaction.reply({
        content: `✅ Pagamento sinalizado! <@&${ADMIN_ROLE_ID}> verifique e finalize a entrega.`,
      });
      return;
    }

    if (action === "close") {
      await interaction.reply("🔒 Fechando ticket em 5 segundos...");
      setTimeout(() => interaction.channel?.delete().catch(() => {}), 5000);
      return;
    }
  }

  // Select menu
  if (interaction.isStringSelectMenu()) {
    const [prefix, ownerId] = interaction.customId.split(":");
    if (prefix !== "add_to_cart") return;

    if (ownerId !== interaction.user.id) {
      return interaction.reply({ content: "❌ Isso não é pra você.", ephemeral: true });
    }

    const productId = interaction.values[0];
    if (productId === "none") {
      return interaction.reply({ content: "Sem produtos cadastrados.", ephemeral: true });
    }

    const p = db.products.find(x => x.id === productId && x.active);
    if (!p) return interaction.reply({ content: "Produto inválido.", ephemeral: true });

    const cart = getCart(interaction.user.id);
    cart.set(productId, (cart.get(productId) || 0) + 1);

    const sum = cartSummary(db, interaction.user.id);
    return interaction.reply({
      content: `✅ Adicionado: **${p.name}**\n\n🧾 **Seu carrinho:**\n${sum.text}`,
      components: [buildCartButtons(interaction.user.id, sum.total > 0)],
      ephemeral: true,
    });
  }
});

client.login(DISCORD_TOKEN);
