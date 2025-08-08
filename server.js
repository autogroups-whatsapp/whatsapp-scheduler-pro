const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());
app.use(express.static('public'));

// Conectar MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-scheduler', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Schemas
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    plan: { type: String, enum: ['free', 'basic', 'premium'], default: 'free' },
    maxGroups: { type: Number, default: 10 },
    maxMessages: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },
    whatsappConnected: { type: Boolean, default: false },
    qrCode: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});

const GroupSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    groupId: { type: String, required: true },
    groupName: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    groupId: { type: String, required: true },
    message: { type: String, required: true },
    scheduledTime: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    sentAt: { type: Date },
    errorMessage: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const CampaignSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    messages: [{ type: String, required: true }],
    groups: [{ type: String, required: true }],
    intervalHours: { type: Number, default: 2 },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

// Modelos
const User = mongoose.model('User', UserSchema);
const Group = mongoose.model('Group', GroupSchema);
const Message = mongoose.model('Message', MessageSchema);
const Campaign = mongoose.model('Campaign', CampaignSchema);

// Armazenar clientes WhatsApp por usuário
const whatsappClients = new Map();

// Middleware de autenticação
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'secret-key', (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
};

// Função para criar cliente WhatsApp com user agent móvel
const createWhatsAppClient = (userId) => {
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `user_${userId}`
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.1 Mobile/15E148 Safari/604.1'
    });

    client.on('qr', async (qr) => {
        console.log('QR Code gerado para usuário:', userId);
        const qrCodeData = await qrcode.toDataURL(qr);
        
        // Salvar QR Code no banco
        await User.findByIdAndUpdate(userId, { qrCode: qrCodeData });
    });

    client.on('ready', async () => {
        console.log('Cliente WhatsApp pronto para usuário:', userId);
        await User.findByIdAndUpdate(userId, { 
            whatsappConnected: true,
            qrCode: null 
        });
    });

    client.on('disconnected', async (reason) => {
        console.log('Cliente desconectado:', reason);
        await User.findByIdAndUpdate(userId, { 
            whatsappConnected: false,
            qrCode: null 
        });
        whatsappClients.delete(userId);
    });

    return client;
};

// Função para enviar mensagem com preview grande
const sendMessageWithLargePreview = async (client, groupId, message) => {
    try {
        // Detectar se há URL na mensagem
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = message.match(urlRegex);
        
        if (urls && urls.length > 0) {
            // Para garantir preview grande, enviamos como se fosse de dispositivo móvel
            const chat = await client.getChatById(groupId);
            
            // Simular comportamento móvel
            await chat.sendMessage(message, {
                linkPreview: true,
                sendMediaAsDocument: false
            });
        } else {
            // Mensagem normal sem links
            await client.sendMessage(groupId, message);
        }
        
        return { success: true };
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        return { success: false, error: error.message };
    }
};

// Rotas de autenticação
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, plan = 'free' } = req.body;

        // Verificar se usuário já existe
        const existingUser = await User.findOne({ 
            $or: [{ email }, { username }] 
        });
        
        if (existingUser) {
            return res.status(400).json({ error: 'Usuário ou email já existe' });
        }

        // Hash da senha
        const hashedPassword = await bcrypt.hash(password, 10);

        // Definir limites por plano
        const planLimits = {
            free: { maxGroups: 10, maxMessages: 100 },
            basic: { maxGroups: 50, maxMessages: 500 },
            premium: { maxGroups: 1000, maxMessages: 10000 }
        };

        const user = new User({
            username,
            email,
            password: hashedPassword,
            plan,
            maxGroups: planLimits[plan].maxGroups,
            maxMessages: planLimits[plan].maxMessages
        });

        await user.save();

        const token = jwt.sign(
            { userId: user._id, username: user.username },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                plan: user.plan,
                maxGroups: user.maxGroups,
                maxMessages: user.maxMessages
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({ 
            $or: [{ username }, { email: username }] 
        });
        
        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        if (!user.isActive) {
            return res.status(401).json({ error: 'Conta desativada' });
        }

        const token = jwt.sign(
            { userId: user._id, username: user.username },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                plan: user.plan,
                maxGroups: user.maxGroups,
                maxMessages: user.maxMessages,
                whatsappConnected: user.whatsappConnected
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rotas do WhatsApp
app.post('/api/whatsapp/connect', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        if (whatsappClients.has(userId)) {
            return res.status(400).json({ error: 'Cliente já conectado' });
        }

        const client = createWhatsAppClient(userId);
        whatsappClients.set(userId, client);
        
        await client.initialize();
        
        res.json({ message: 'Inicializando conexão WhatsApp' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/qr', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        
        if (!user.qrCode) {
            return res.status(404).json({ error: 'QR Code não disponível' });
        }

        res.json({ qrCode: user.qrCode });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/status', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const client = whatsappClients.get(req.user.userId);
        
        res.json({
            connected: user.whatsappConnected,
            hasQrCode: !!user.qrCode,
            clientActive: !!client
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/whatsapp/groups', authenticateToken, async (req, res) => {
    try {
        const client = whatsappClients.get(req.user.userId);
        
        if (!client) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantCount: chat.participants ? chat.participants.length : 0
            }));

        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rotas de grupos
app.post('/api/groups', authenticateToken, async (req, res) => {
    try {
        const { groupId, groupName } = req.body;
        const userId = req.user.userId;

        // Verificar limite de grupos
        const user = await User.findById(userId);
        const groupCount = await Group.countDocuments({ userId });
        
        if (groupCount >= user.maxGroups) {
            return res.status(400).json({ 
                error: `Limite de ${user.maxGroups} grupos atingido para seu plano` 
            });
        }

        const group = new Group({
            userId,
            groupId,
            groupName
        });

        await group.save();
        res.json(group);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Grupo já adicionado' });
        }
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const groups = await Group.find({ userId: req.user.userId });
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rotas de campanhas
app.post('/api/campaigns', authenticateToken, async (req, res) => {
    try {
        const { name, messages, groups, intervalHours, startDate, endDate } = req.body;
        const userId = req.user.userId;

        const campaign = new Campaign({
            userId,
            name,
            messages,
            groups,
            intervalHours,
            startDate: new Date(startDate),
            endDate: endDate ? new Date(endDate) : null
        });

        await campaign.save();

        // Criar mensagens agendadas
        await createScheduledMessages(campaign);

        res.json(campaign);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/campaigns', authenticateToken, async (req, res) => {
    try {
        const campaigns = await Campaign.find({ userId: req.user.userId });
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Função para criar mensagens agendadas
const createScheduledMessages = async (campaign) => {
    const startDate = new Date(campaign.startDate);
    const endDate = campaign.endDate ? new Date(campaign.endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias se não especificado

    let currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
        for (let i = 0; i < campaign.messages.length; i++) {
            for (const groupId of campaign.groups) {
                const scheduledTime = new Date(currentDate.getTime() + (i * campaign.intervalHours * 60 * 60 * 1000));
                
                if (scheduledTime <= endDate) {
                    const message = new Message({
                        userId: campaign.userId,
                        groupId,
                        message: campaign.messages[i],
                        scheduledTime
                    });
                    
                    await message.save();
                }
            }
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
    }
};

// Cron job para envio de mensagens
cron.schedule('* * * * *', async () => {
    console.log('Verificando mensagens para envio...');
    
    const now = new Date();
    const messages = await Message.find({
        status: 'pending',
        scheduledTime: { $lte: now }
    }).limit(50);

    for (const message of messages) {
        try {
            const client = whatsappClients.get(message.userId.toString());
            
            if (!client) {
                message.status = 'failed';
                message.errorMessage = 'WhatsApp não conectado';
                await message.save();
                continue;
            }

            const result = await sendMessageWithLargePreview(client, message.groupId, message.message);
            
            if (result.success) {
                message.status = 'sent';
                message.sentAt = new Date();
            } else {
                message.status = 'failed';
                message.errorMessage = result.error;
            }
            
            await message.save();
        } catch (error) {
            message.status = 'failed';
            message.errorMessage = error.message;
            await message.save();
        }
    }
});

// Rotas de relatórios
app.get('/api/reports/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        const totalGroups = await Group.countDocuments({ userId });
        const totalMessages = await Message.countDocuments({ userId });
        const sentMessages = await Message.countDocuments({ userId, status: 'sent' });
        const pendingMessages = await Message.countDocuments({ userId, status: 'pending' });
        const failedMessages = await Message.countDocuments({ userId, status: 'failed' });
        
        res.json({
            totalGroups,
            totalMessages,
            sentMessages,
            pendingMessages,
            failedMessages,
            successRate: totalMessages > 0 ? ((sentMessages / totalMessages) * 100).toFixed(2) : 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Servir frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicializar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});

module.exports = app;
