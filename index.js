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

if (!DISCORD_TOKEN) throw new Error("Faltou DISCORD_TOKEN nas variáveis do Railway.");
if (!CLIENT_ID) throw new Error("Faltou CLIENT_ID nas variáveis do Railway.");
if (!GUILD_ID) throw new Error("Faltou GUILD_ID nas variáveis do Railway.");
if (!ADMIN_ROLE_ID) throw new Error("Faltou ADMIN_ROLE_ID nas variáveis do Railway.");
if (!SALES_CATEGORY_ID) throw new Error("Faltou SALES_CATEGORY_ID nas variáveis do Railway.");

const DB_PATH = path.join(__dirname, "db.json");

// ---------- DB ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify(
        {
          products: [],
          pix: { key: "", name: "", city: "", qrUrl: "" },
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
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.roles.cache.has(ADMIN_ROLE_ID)
  );
}

function brl(n) {
  return `R$ ${Number(n).toFixed(2)}`;
}

// ---------- Cart (per user, per channel) ----------
// key: `${userId}:${channelId}` -> Map(productId -> qty)
const carts = new Map();

function cartKey(userId, channelId) {
  return `${userId}:${channelId}`;
}
function getCart(userId, channelId) {
  const key = cartKey(userId, channelId);
  if (!carts.has(key)) carts.set(key, new Map());
  return carts.get(key);
}
function clearCart(userId, channelId) {
  carts.delete(cartKey(userId, channelId));
}

function getProductsForChannel(db, channelId) {
  return db.products.filter((p) => p.active && p.channelId === channelId);
}

function cartSummary(db, userId, channelId) {
  const cart = getCart(userId, channelId);
  const products = getProductsForChannel(db, channelId);

  let total = 0;
  const lines = [];

  for (const [pid, qty] of cart.entries()) {
    const p = products.find((x) => x.id === pid);
    if (!p) continue;
    const sub = p.price * qty;
    total += sub;
    lines.push(`• **${p.name}** x${qty} — ${brl(sub)}`);
  }

  if (!lines.length) return { text: "Seu carrinho está vazio.", total: 0 };
  return { text: lines.join("\n") + `\n\n**Total:** ${brl(total)}`, total };
}

// ---------- UI builders ----------
function buildPanelEmbed({ title, description, footer, imageUrl }) {
  const embed = new EmbedBuilder().setTitle(title).setDescription(description);
  if (footer) embed.setFooter({ text: footer });
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

function buildProductMenu(db, ownerId, channelId) {
  const products = getProductsForChannel(db, channelId);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`add_to_cart:${ownerId}:${channelId}`)
    .setPlaceholder(products.length ? "Escolha um produto" : "Sem produtos neste canal")
    .setMinValues(1)
    .setMaxValues(1);

  if (!products.length) {
    menu.addOptions([{ label: "Nenhum produto cadastrado", value: "none" }]);
    menu.setDisabled(true);
  } else {
    menu.addOptions(
      products.slice(0, 25).map((p) => ({
        label: `${p.name} — ${brl(p.price)}`,
        description: (p.description || "").slice(0, 100) || "Sem descrição",
        value: p.id,
      }))
    );
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildCartButtons(ownerId, channelId, canCheckout) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_more:${ownerId}:${channelId}`)
      .setLabel("Adicionar mais")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("➕"),
    new ButtonBuilder()
      .setCustomId(`clear_cart:${ownerId}:${channelId}`)
      .setLabel("Esvaziar")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🗑️"),
    new ButtonBuilder()
      .setCustomId(`checkout:${ownerId}:${channelId}`)
      .setLabel("Finalizar")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(!canCheckout)
  );
}

function buildConfirmButtons(ownerId, channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_order:${ownerId}:${channelId}`)
      .setLabel("Confirmar compra")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`cancel_order:${ownerId}:${channelId}`)
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

// ---------- Slash commands register ----------
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("painel")
      .setDescription("Posta o painel da loja neste canal (texto personalizável).")
      .addStringOption((o) =>
        o.setName("titulo").setDescription("Título do anúncio").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("descricao").setDescription("Texto do anúncio").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("rodape").setDescription("Rodapé (opcional)").setRequired(false)
      )
      .addAttachmentOption((o) =>
        o.setName("imagem").setDescription("Imagem do painel (opcional)").setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("pix")
      .setDescription("Configurar PIX (admin)")
      .addStringOption((o) =>
        o.setName("chave").setDescription("Chave PIX").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("nome").setDescription("Nome do recebedor").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("cidade").setDescription("Cidade").setRequired(true)
      )
      .addAttachmentOption((o) =>
        o.setName("qr").setDescription("Imagem do QR Code (opcional)").setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("produto")
      .setDescription("Gerenciar produtos (por canal)")
      .addSubcommand((s) =>
        s
          .setName("adicionar")
          .setDescription("Adiciona produto PARA ESTE CANAL (admin)")
          .addStringOption((o) =>
            o.setName("nome").setDescription("Nome do produto").setRequired(true)
          )
          .addNumberOption((o) =>
            o.setName("preco").setDescription("Preço").setRequired(true)
          )
          .addStringOption((o) =>
            o.setName("descricao").setDescription("Descrição (opcional)").setRequired(false)
          )
          .addAttachmentOption((o) =>
            o.setName("imagem").setDescription("Imagem do produto (opcional)").setRequired(false)
          )
      )
      .addSubcommand((s) =>
        s.setName("listar").setDescription("Lista produtos deste canal")
      )
      .addSubcommand((s) =>
        s
          .setName("remover")
          .setDescription("Desativa um produto deste canal (admin)")
          .addStringOption((o) => o.setName("id").setDescription("ID do produto").setRequired(true))
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
}

// ---------- Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  await registerCommands();
  console.log(`✅ Logado como ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    const db = loadDB();

    // ----- Slash Commands -----
    if (interaction.isChatInputCommand()) {
      // /painel
      if (interaction.commandName === "painel") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: "❌ Só admins podem usar /painel.", ephemeral: true });
        }

        const title = interaction.options.getString("titulo", true);
        const description = interaction.options.getString("descricao", true);
        const footer = interaction.options.getString("rodape") || "";
        const att = interaction.options.getAttachment("imagem");
        const imageUrl = att?.url || "";

        return interaction.reply({
          embeds: [buildPanelEmbed({ title, description, footer, imageUrl })],
          components: buildPanelButtons(),
        });
      }

      // /pix
      if (interaction.commandName === "pix") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: "❌ Só admins podem configurar PIX.", ephemeral: true });
        }

        db.pix.key = interaction.options.getString("chave", true);
        db.pix.name = interaction.options.getString("nome", true);
        db.pix.city = interaction.options.getString("cidade", true);

        const qr = interaction.options.getAttachment("qr");
        if (qr?.url) db.pix.qrUrl = qr.url;

        saveDB(db);

        return interaction.reply({
          content:
            `✅ PIX configurado!\n` +
            `• Chave: \`${db.pix.key}\`\n` +
            `• Nome: ${db.pix.name}\n` +
            `• Cidade: ${db.pix.city}\n` +
            `• QR: ${db.pix.qrUrl ? "OK" : "Não definido"}`,
          ephemeral: true,
        });
      }

      // /produto
      if (interaction.commandName === "produto") {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: "❌ Só admins.", ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        const channelId = interaction.channelId;

        if (sub === "adicionar") {
          const name = interaction.options.getString("nome", true);
          const price = interaction.options.getNumber("preco", true);
          const description = interaction.options.getString("descricao") || "";
          const img = interaction.options.getAttachment("imagem");
          const imageUrl = img?.url || "";

          const id = `p_${Date.now()}`;

          db.products.push({
            id,
            channelId,      // <- preso ao canal atual
            name,
            price: Number(price),
            description,
            imageUrl,
            active: true,
          });
          saveDB(db);

          return interaction.reply({
            content:
              `✅ Produto adicionado **neste canal** (<#${channelId}>):\n` +
              `• **${name}** — ${brl(price)}\n` +
              `• ID: \`${id}\``,
            ephemeral: true,
          });
        }

        if (sub === "listar") {
          const list = getProductsForChannel(db, channelId);
          if (!list.length) {
            return interaction.reply({ content: "📦 Nenhum produto cadastrado neste canal.", ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setTitle(`📦 Produtos do canal: #${interaction.channel?.name || "canal"}`)
            .setDescription("Use `/produto remover id:...` para desativar um produto.");

          for (const p of list) {
            embed.addFields({
              name: `${p.name} — ${brl(p.price)}`,
              value: `ID: \`${p.id}\`\n${(p.description || "Sem descrição").slice(0, 200)}`,
            });
          }

          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (sub === "remover") {
          const id = interaction.options.getString("id", true);
          const p = db.products.find((x) => x.id === id && x.channelId === channelId);
          if (!p) return interaction.reply({ content: "❌ Produto não encontrado neste canal.", ephemeral: true });
          p.active = false;
          saveDB(db);
          return interaction.reply({ content: `🗑️ Produto desativado: **${p.name}**`, ephemeral: true });
        }
      }

      return;
    }

    // ----- Buttons -----
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // Abre menu (lista produtos SOMENTE do canal do painel)
      if (cid === "open_menu") {
        return interaction.reply({
          content: "Selecione um produto (somente deste canal):",
          components: [buildProductMenu(db, interaction.user.id, interaction.channelId)],
          ephemeral: true,
        });
      }

      // Ver carrinho (somente daquele canal)
      if (cid === "view_cart") {
        const sum = cartSummary(db, interaction.user.id, interaction.channelId);
        return interaction.reply({
          content: `🧾 **Seu carrinho (canal atual):**\n${sum.text}`,
          components: [buildCartButtons(interaction.user.id, interaction.channelId, sum.total > 0)],
          ephemeral: true,
        });
      }

      // Actions with owner + channel
      const parts = cid.split(":");
      const action = parts[0];
      const ownerId = parts[1];
      const channelIdFromId = parts[2]; // para ações do carrinho

      const protectedActions = new Set(["add_more", "clear_cart", "checkout", "confirm_order", "cancel_order"]);
      if (protectedActions.has(action)) {
        if (ownerId !== interaction.user.id) {
          return interaction.reply({ content: "❌ Isso não é pra você.", ephemeral: true });
        }
        if (channelIdFromId !== interaction.channelId) {
          return interaction.reply({ content: "❌ Isso é de outro canal.", ephemeral: true });
        }
      }

      if (action === "add_more") {
        return interaction.reply({
          content: "Escolha mais um produto deste canal:",
          components: [buildProductMenu(db, interaction.user.id, interaction.channelId)],
          ephemeral: true,
        });
      }

      if (action === "clear_cart") {
        clearCart(interaction.user.id, interaction.channelId);
        return interaction.update({
          content: "🗑️ Carrinho esvaziado.",
          components: [buildCartButtons(interaction.user.id, interaction.channelId, false)],
        });
      }

      if (action === "checkout") {
        const sum = cartSummary(db, interaction.user.id, interaction.channelId);
        const embed = new EmbedBuilder().setTitle("✅ Revisar pedido").setDescription(sum.text);

        return interaction.reply({
          embeds: [embed],
          components: [buildConfirmButtons(interaction.user.id, interaction.channelId)],
          ephemeral: true,
        });
      }

      if (action === "cancel_order") {
        return interaction.update({ content: "Compra cancelada.", embeds: [], components: [] });
      }

      if (action === "confirm_order") {
        // PIX tem que estar configurado
        if (!db.pix.key || !db.pix.name || !db.pix.city) {
          return interaction.reply({ content: "❌ PIX não configurado. Admin use `/pix`.", ephemeral: true });
        }

        const sum = cartSummary(db, interaction.user.id, interaction.channelId);
        if (sum.total <= 0) {
          return interaction.reply({ content: "Seu carrinho está vazio.", ephemeral: true });
        }

        // cria ticket privado
        const guild = interaction.guild;
        const category = guild.channels.cache.get(SALES_CATEGORY_ID);
        if (!category) {
          return interaction.reply({ content: "❌ SALES_CATEGORY_ID inválido.", ephemeral: true });
        }

        const ticketName = `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
        const channel = await guild.channels.create({
          name: ticketName.slice(0, 90),
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              id: ADMIN_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ],
        });

        const payEmbed = new EmbedBuilder()
          .setTitle("💳 Pagamento via PIX")
          .setDescription(
            `Olá <@${interaction.user.id}>!\n\n` +
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

        // limpa carrinho daquele canal
        clearCart(interaction.user.id, interaction.channelId);

        return interaction.update({
          content: `✅ Ticket criado: <#${channel.id}>`,
          embeds: [],
          components: [],
        });
      }

      // ticket buttons (owner-only)
      if (cid.startsWith("paid:")) {
        const owner = cid.split(":")[1];
        if (owner !== interaction.user.id) {
          return interaction.reply({ content: "❌ Só o dono do ticket pode usar isso.", ephemeral: true });
        }
        return interaction.reply({
          content: `✅ Pagamento sinalizado! <@&${ADMIN_ROLE_ID}> verifique e finalize a entrega.`,
        });
      }

      if (cid.startsWith("close:")) {
        const owner = cid.split(":")[1];
        const isOwner = owner === interaction.user.id;
        const isStaff = interaction.member.roles?.cache?.has(ADMIN_ROLE_ID);
        if (!isOwner && !isStaff) {
          return interaction.reply({ content: "❌ Você não pode fechar este ticket.", ephemeral: true });
        }
        await interaction.reply("🔒 Fechando ticket em 5 segundos...");
        setTimeout(() => interaction.channel?.delete().catch(() => {}), 5000);
        return;
      }
    }

    // ----- Select menu -----
    if (interaction.isStringSelectMenu()) {
      const [prefix, ownerId, channelIdFromId] = interaction.customId.split(":");
      if (prefix !== "add_to_cart") return;

      if (ownerId !== interaction.user.id) {
        return interaction.reply({ content: "❌ Isso não é pra você.", ephemeral: true });
      }
      if (channelIdFromId !== interaction.channelId) {
        return interaction.reply({ content: "❌ Isso é de outro canal.", ephemeral: true });
      }

      const productId = interaction.values[0];
      if (productId === "none") {
        return interaction.reply({ content: "Sem produtos neste canal.", ephemeral: true });
      }

      const products = getProductsForChannel(db, interaction.channelId);
      const p = products.find((x) => x.id === productId);
      if (!p) return interaction.reply({ content: "Produto inválido.", ephemeral: true });

      const cart = getCart(interaction.user.id, interaction.channelId);
      cart.set(productId, (cart.get(productId) || 0) + 1);

      const sum = cartSummary(db, interaction.user.id, interaction.channelId);

      const embed = new EmbedBuilder()
        .setTitle("🧾 Carrinho atualizado")
        .setDescription(sum.text);

      if (p.imageUrl) embed.setThumbnail(p.imageUrl);

      return interaction.reply({
        embeds: [embed],
        components: [buildCartButtons(interaction.user.id, interaction.channelId, sum.total > 0)],
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "❌ Deu erro. Veja os Logs no Railway.", ephemeral: true });
      } catch {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
