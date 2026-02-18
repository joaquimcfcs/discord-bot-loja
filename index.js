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
  ChannelType,
  EmbedBuilder,
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

const DB_PATH = path.join(__dirname, "db.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ products: [], orders: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function isAdmin(member) {
  return member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

// ---------- Slash Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("produto")
    .setDescription("Gerenciar produtos")
    .addSubcommand((s) =>
      s
        .setName("adicionar")
        .setDescription("Adicionar um produto (admin)")
        .addStringOption((o) => o.setName("nome").setDescription("Nome").setRequired(true))
        .addNumberOption((o) => o.setName("preco").setDescription("Preço (ex: 19.90)").setRequired(true))
        .addStringOption((o) => o.setName("descricao").setDescription("Descrição").setRequired(true))
        .addStringOption((o) => o.setName("entrega").setDescription("Texto de entrega (ex: chave/licença/link)").setRequired(true))
    )
    .addSubcommand((s) => s.setName("listar").setDescription("Listar produtos")),

  new SlashCommandBuilder()
    .setName("comprar")
    .setDescription("Comprar um produto")
    .addStringOption((o) => o.setName("nome").setDescription("Nome do produto").setRequired(true)),

  new SlashCommandBuilder()
    .setName("confirmar")
    .setDescription("Confirmar pagamento de um pedido (admin)")
    .addStringOption((o) => o.setName("pedido_id").setDescription("ID do pedido").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ajuda_vendas")
    .setDescription("Mostra como comprar e regras"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash commands registrados.");
}

// ---------- Bot ----------
client.once("ready", async () => {
  console.log(`🤖 Logado como ${client.user.tag}`);
  await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const db = loadDB();

  if (interaction.commandName === "produto") {
    const sub = interaction.options.getSubcommand();

    if (sub === "adicionar") {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: "❌ Apenas admins podem adicionar produtos.", ephemeral: true });
      }

      const nome = interaction.options.getString("nome");
      const preco = interaction.options.getNumber("preco");
      const descricao = interaction.options.getString("descricao");
      const entrega = interaction.options.getString("entrega");

      if (db.products.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
        return interaction.reply({ content: "⚠️ Já existe um produto com esse nome.", ephemeral: true });
      }

      db.products.push({
        id: `p_${Date.now()}`,
        nome,
        preco,
        descricao,
        entrega,
        ativo: true,
      });
      saveDB(db);

      return interaction.reply({ content: `✅ Produto **${nome}** adicionado por R$ ${preco.toFixed(2)}.` });
    }

    if (sub === "listar") {
      if (db.products.length === 0) {
        return interaction.reply({ content: "📦 Nenhum produto cadastrado ainda.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("📦 Catálogo de Produtos")
        .setDescription("Use `/comprar nome:<produto>` para abrir um ticket de compra.")
        .setTimestamp();

      db.products.filter(p => p.ativo).forEach((p) => {
        embed.addFields({
          name: `${p.nome} — R$ ${p.preco.toFixed(2)}`,
          value: `${p.descricao}\n**Produto:** \`${p.id}\``,
        });
      });

      return interaction.reply({ embeds: [embed] });
    }
  }

  if (interaction.commandName === "ajuda_vendas") {
    const embed = new EmbedBuilder()
      .setTitle("🛒 Como comprar")
      .setDescription(
        [
          "1) Veja o catálogo: `/produto listar`",
          "2) Abra uma compra: `/comprar nome:<produto>`",
          "3) No ticket, siga as instruções de pagamento",
          "4) Um admin confirma com `/confirmar pedido_id:<id>` e você recebe a entrega",
        ].join("\n")
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "comprar") {
    const nome = interaction.options.getString("nome");
    const product = db.products.find((p) => p.ativo && p.nome.toLowerCase() === nome.toLowerCase());

    if (!product) {
      return interaction.reply({
        content: "❌ Produto não encontrado. Use `/produto listar` para ver os nomes exatos.",
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    const categoryId = process.env.SALES_CATEGORY_ID;

    const channel = await guild.channels.create({
      name: `compra-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, ""),
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
        { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
        { id: process.env.ADMIN_ROLE_ID, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
      ],
    });

    const order = {
      id: `o_${Date.now()}`,
      productId: product.id,
      productName: product.nome,
      price: product.preco,
      buyerId: interaction.user.id,
      channelId: channel.id,
      status: "PENDENTE",
      createdAt: new Date().toISOString(),
    };
    db.orders.push(order);
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle("🧾 Pedido criado")
      .addFields(
        { name: "Pedido ID", value: `\`${order.id}\``, inline: true },
        { name: "Produto", value: product.nome, inline: true },
        { name: "Valor", value: `R$ ${product.preco.toFixed(2)}`, inline: true },
        { name: "Status", value: order.status, inline: true },
      )
      .setDescription(
        [
          "✅ Este é seu ticket privado de compra.",
          "",
          "**Pagamento (exemplo):**",
          "• Pix: `SUA_CHAVE_PIX_AQUI`",
          "• Envie o comprovante aqui no ticket.",
          "",
          "Após pagamento, um admin confirma com:",
          `\`/confirmar pedido_id:${order.id}\``,
        ].join("\n")
      )
      .setTimestamp();

    await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed] });

    return interaction.reply({
      content: `🛒 Ticket criado: <#${channel.id}> (Pedido \`${order.id}\`)`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "confirmar") {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "❌ Apenas admins podem confirmar pagamento.", ephemeral: true });
    }

    const pedidoId = interaction.options.getString("pedido_id");
    const order = db.orders.find((o) => o.id === pedidoId);

    if (!order) return interaction.reply({ content: "❌ Pedido não encontrado.", ephemeral: true });
    if (order.status === "PAGO") return interaction.reply({ content: "⚠️ Esse pedido já está como PAGO.", ephemeral: true });

    const product = db.products.find((p) => p.id === order.productId);
    if (!product) return interaction.reply({ content: "❌ Produto desse pedido não existe mais.", ephemeral: true });

    order.status = "PAGO";
    order.paidAt = new Date().toISOString();
    saveDB(db);

    const channel = await interaction.guild.channels.fetch(order.channelId).catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle("✅ Pagamento confirmado")
      .addFields(
        { name: "Pedido ID", value: `\`${order.id}\``, inline: true },
        { name: "Produto", value: product.nome, inline: true },
        { name: "Entrega", value: product.entrega }
      )
      .setTimestamp();

    if (channel) await channel.send({ content: `<@${order.buyerId}>`, embeds: [embed] });

    return interaction.reply({ content: `✅ Pedido \`${order.id}\` confirmado e entregue.` });
  }
});

client.login(process.env.DISCORD_TOKEN);
