const express = require('express');
const session = require('express-session');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const app = express();

const settings = require('./settings.js');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'pterodactyl-panel-secret-key-2024',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

const databasePath = path.join(__dirname, 'database');
const usersPath = path.join(databasePath, 'users.json');
const ordersPath = path.join(databasePath, 'orders.json');
const panelsPath = path.join(databasePath, 'panels.json');

async function initDatabase() {
    try {
        await fs.mkdir(databasePath, { recursive: true });
        
        const defaultFiles = [
            { path: usersPath, default: [] },
            { path: ordersPath, default: [] },
            { path: panelsPath, default: [] }
        ];
        
        for (const file of defaultFiles) {
            try {
                await fs.access(file.path);
            } catch {
                await fs.writeFile(file.path, JSON.stringify(file.default, null, 2));
            }
        }
        
        const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
        const adminExists = users.find(u => u.username === 'admin');
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('adminmanage', 10);
            users.push({
                id: 'admin-001',
                username: 'admin',
                password: hashedPassword,
                email: 'admin@panel.com',
                role: 'admin',
                createdAt: new Date().toISOString()
            });
            await fs.writeFile(usersPath, JSON.stringify(users, null, 2));
        }
    } catch (error) {
        console.error('Database init error:', error);
    }
}

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.redirect('/login');
    }
    next();
}

async function sendTelegramNotification(message) {
    if (!settings.telegramBotToken || !settings.telegramOwnerId) return;
    try {
        const bot = new TelegramBot(settings.telegramBotToken);
        await bot.sendMessage(settings.telegramOwnerId, message);
    } catch (error) {
        console.error('Telegram notification error:', error);
    }
}

async function createPanelAccount(plan, username, password, email) {
    const preset = {
        '1gb': [1000, 1000, 40], '2gb': [2000, 1000, 60], '3gb': [3000, 2000, 80],
        '4gb': [4000, 2000, 100], '5gb': [5000, 3000, 120], '6gb': [6000, 3000, 140],
        '7gb': [7000, 4000, 160], '8gb': [8000, 4000, 180], '9gb': [9000, 5000, 200],
        '10gb': [10000, 5000, 220], 'unlimited': [0, 0, 0]
    };
    
    const [ram, disk, cpu] = preset[plan];
    const panelUsername = username.toLowerCase();
    const panelEmail = email || `${panelUsername}@gmail.com`;
    const panelPassword = password || panelUsername + '01';
    const panelName = username.charAt(0).toUpperCase() + username.slice(1) + ' Server';
    
    try {
        const userRes = await axios.post(`${settings.pterodactylDomain}/api/application/users`, {
            email: panelEmail,
            username: panelUsername,
            first_name: panelName,
            last_name: 'Server',
            language: 'en',
            password: panelPassword
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.pterodactylApiKey}`
            }
        });
        
        const userData = userRes.data;
        if (userData.errors) throw new Error(JSON.stringify(userData.errors[0]));
        
        const userId = userData.attributes.id;
        
        const eggRes = await axios.get(
            `${settings.pterodactylDomain}/api/application/nests/${settings.pterodactylNestId}/eggs/${settings.pterodactylEggId}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.pterodactylApiKey}`
                }
            }
        );
        
        const eggData = eggRes.data;
        const startupCmd = eggData.attributes.startup;
        const description = new Date().toLocaleString('id-ID');
        
        const serverRes = await axios.post(`${settings.pterodactylDomain}/api/application/servers`, {
            name: panelName,
            description: description,
            user: userId,
            egg: parseInt(settings.pterodactylEggId),
            docker_image: 'ghcr.io/parkervcp/yolks:nodejs_20',
            startup: startupCmd,
            environment: {
                INST: 'npm',
                USER_UPLOAD: '0',
                AUTO_UPDATE: '0',
                CMD_RUN: 'npm start'
            },
            limits: {
                memory: ram,
                swap: 0,
                disk: disk,
                io: 500,
                cpu: cpu
            },
            feature_limits: {
                databases: 5,
                backups: 5,
                allocations: 5
            },
            deploy: {
                locations: [parseInt(settings.pterodactylLocationId)],
                dedicated_ip: false,
                port_range: []
            }
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.pterodactylApiKey}`
            }
        });
        
        const serverData = serverRes.data;
        if (serverData.errors) throw new Error(JSON.stringify(serverData.errors[0]));
        
        const formatGB = (val) => val === 0 ? 'Unlimited' : (val / 1000) + 'GB';
        
        const panelInfo = {
            userId: userId,
            serverId: serverData.attributes.id,
            uuid: serverData.attributes.uuid,
            identifier: serverData.attributes.identifier,
            username: panelUsername,
            password: panelPassword,
            email: panelEmail,
            plan: plan,
            specs: {
                ram: formatGB(ram),
                cpu: cpu === 0 ? 'Unlimited' : cpu + '%',
                disk: formatGB(disk)
            },
            loginUrl: `${settings.pterodactylDomain}`,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        };
        
        const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
        panels.push(panelInfo);
        await fs.writeFile(panelsPath, JSON.stringify(panels, null, 2));
        
        await sendTelegramNotification(
            `✅ PANEL BARU DIBUAT\n` +
            `👤 User: ${username}\n` +
            `📦 Plan: ${plan}\n` +
            `🆔 Server ID: ${serverData.attributes.id}\n` +
            `⏰ Waktu: ${new Date().toLocaleString('id-ID')}`
        );
        
        return panelInfo;
    } catch (error) {
        console.error('Create panel error:', error);
        throw error;
    }
}

async function createQrisPayment(amount, orderId) {
    try {
        const response = await axios.post(
            'https://app.pakasir.com/api/transactioncreate/qris',
            {
                project: settings.pakasirSlug,
                order_id: orderId,
                amount: amount,
                api_key: settings.pakasirApiKey
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );
        
        if (!response.data || !response.data.payment) {
            throw new Error('Gagal membuat QRIS');
        }
        
        return response.data.payment;
    } catch (error) {
        console.error('Create QRIS error:', error);
        throw error;
    }
}

async function checkPaymentStatus(orderId, amount) {
    try {
        const response = await axios.get(
            'https://app.pakasir.com/api/transactiondetail',
            {
                params: {
                    project: settings.pakasirSlug,
                    order_id: orderId,
                    amount: amount,
                    api_key: settings.pakasirApiKey
                }
            }
        );
        
        return response.data?.transaction;
    } catch (error) {
        console.error('Check payment error:', error);
        return null;
    }
}

app.get('/', async (req, res) => {
    const faqs = [
        { q: 'Apa itu Panel Pterodactyl?', a: 'Panel kontrol untuk mengelola server game dengan mudah melalui web interface.' },
        { q: 'Berapa lama proses aktivasi?', a: 'Instan setelah pembayaran berhasil.' },
        { q: 'Apakah ada garansi?', a: 'Garansi aktif 30 hari, jika down akan direplace.' },
        { q: 'Bisa request spesifikasi custom?', a: 'Ya, hubungi admin via kontak yang tersedia.' }
    ];
    
    const testimonials = [
        { name: 'Rizki', rating: 5, comment: 'Panelnya stable banget, recomended!' },
        { name: 'Sandi', rating: 5, comment: 'Proses cepat, admin responsif.' },
        { name: 'Ahmad', rating: 4, comment: 'Harga terjangkau, fitur lengkap.' }
    ];
    
    res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Panel Pterodactyl Murah</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                :root {
                    --primary: #8b5cf6;
                    --primary-dark: #7c3aed;
                    --secondary: #1f2937;
                }
                body {
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                    color: #e2e8f0;
                    min-height: 100vh;
                }
                .btn-primary {
                    background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
                    transition: all 0.3s ease;
                }
                .btn-primary:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
                }
                .glass {
                    background: rgba(30, 41, 59, 0.7);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .price-card {
                    transition: all 0.3s ease;
                }
                .price-card:hover {
                    transform: translateY(-10px);
                    border-color: var(--primary);
                }
                .star {
                    color: #fbbf24;
                }
            </style>
        </head>
        <body class="font-sans">
            <nav class="glass fixed w-full z-50 py-4 px-6">
                <div class="container mx-auto flex justify-between items-center">
                    <div class="text-2xl font-bold">
                        <i class="fas fa-server text-purple-500"></i>
                        <span class="ml-2">PteroPanel</span>
                    </div>
                    <div class="space-x-4">
                        <a href="/" class="hover:text-purple-400">Home</a>
                        <a href="/pricing" class="hover:text-purple-400">Pricing</a>
                        ${req.session.user ? 
                            `<a href="/dashboard" class="hover:text-purple-400">Dashboard</a>
                             <a href="/logout" class="btn-primary px-4 py-2 rounded-lg">Logout</a>` :
                            `<a href="/login" class="btn-primary px-4 py-2 rounded-lg">Login</a>`
                        }
                    </div>
                </div>
            </nav>

            <main class="pt-24 pb-16 px-4">
                <div class="container mx-auto">
                    <section class="text-center mb-16">
                        <h1 class="text-5xl font-bold mb-6">Panel Pterodactyl Premium</h1>
                        <p class="text-xl text-gray-300 mb-8 max-w-3xl mx-auto">
                            Server panel berkualitas tinggi dengan harga terjangkau. 
                            Processor AMD EPYC, garansi 30 hari, dan support 24/7.
                        </p>
                        <div class="space-x-4">
                            <a href="/pricing" class="btn-primary px-8 py-3 rounded-lg text-lg font-semibold inline-block">
                                <i class="fas fa-shopping-cart"></i> Order Sekarang
                            </a>
                            <a href="#features" class="glass px-8 py-3 rounded-lg text-lg font-semibold inline-block">
                                <i class="fas fa-info-circle"></i> Learn More
                            </a>
                        </div>
                    </section>

                    <section id="features" class="mb-16">
                        <h2 class="text-3xl font-bold text-center mb-12">Spesifikasi Panel</h2>
                        <div class="grid md:grid-cols-3 gap-8">
                            <div class="glass p-6 rounded-xl text-center">
                                <i class="fas fa-microchip text-4xl text-purple-500 mb-4"></i>
                                <h3 class="text-xl font-bold mb-2">AMD EPYC Processor</h3>
                                <p class="text-gray-300">Processor server kelas enterprise untuk performa maksimal</p>
                            </div>
                            <div class="glass p-6 rounded-xl text-center">
                                <i class="fas fa-shield-alt text-4xl text-purple-500 mb-4"></i>
                                <h3 class="text-xl font-bold mb-2">Garansi 30 Hari</h3>
                                <p class="text-gray-300">Garansi aktif penuh, replace jika terjadi masalah</p>
                            </div>
                            <div class="glass p-6 rounded-xl text-center">
                                <i class="fas fa-bolt text-4xl text-purple-500 mb-4"></i>
                                <h3 class="text-xl font-bold mb-2">Instan Aktif</h3>
                                <p class="text-gray-300">Panel aktif instan setelah pembayaran berhasil</p>
                            </div>
                        </div>
                    </section>

                    <section class="mb-16">
                        <h2 class="text-3xl font-bold text-center mb-12">Testimonial</h2>
                        <div class="grid md:grid-cols-3 gap-8">
                            ${testimonials.map(t => `
                                <div class="glass p-6 rounded-xl">
                                    <div class="flex items-center mb-4">
                                        <div class="w-12 h-12 rounded-full bg-purple-600 flex items-center justify-center font-bold">
                                            ${t.name.charAt(0)}
                                        </div>
                                        <div class="ml-4">
                                            <h4 class="font-bold">${t.name}</h4>
                                            <div class="flex">
                                                ${Array(5).fill().map((_, i) => 
                                                    `<i class="fas fa-star star ${i < t.rating ? 'text-yellow-500' : 'text-gray-600'}"></i>`
                                                ).join('')}
                                            </div>
                                        </div>
                                    </div>
                                    <p class="text-gray-300">"${t.comment}"</p>
                                </div>
                            `).join('')}
                        </div>
                    </section>

                    <section class="mb-16">
                        <h2 class="text-3xl font-bold text-center mb-12">FAQ</h2>
                        <div class="max-w-3xl mx-auto space-y-4">
                            ${faqs.map(faq => `
                                <div class="glass p-6 rounded-xl">
                                    <h3 class="font-bold text-lg mb-2">${faq.q}</h3>
                                    <p class="text-gray-300">${faq.a}</p>
                                </div>
                            `).join('')}
                        </div>
                    </section>

                    <section class="text-center">
                        <h2 class="text-3xl font-bold mb-8">Contact Owner</h2>
                        <div class="glass inline-block p-8 rounded-xl">
                            <p class="mb-4"><i class="fas fa-envelope mr-2"></i> admin@panelpterodactyl.com</p>
                            <p class="mb-4"><i class="fab fa-telegram mr-2"></i> @pteropanel_support</p>
                            <p><i class="fas fa-phone mr-2"></i> +62 812-3456-7890</p>
                        </div>
                    </section>
                </div>
            </main>

            <footer class="glass py-8 text-center">
                <div class="container mx-auto">
                    <p>&copy; 2024 PteroPanel. All rights reserved.</p>
                </div>
            </footer>
        </body>
        </html>
    `);
});

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login - Panel Pterodactyl</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body {
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .login-box {
                    background: rgba(30, 41, 59, 0.8);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    width: 100%;
                    max-width: 400px;
                }
                .btn-login {
                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                }
                .btn-login:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
                }
            </style>
        </head>
        <body>
            <div class="login-box rounded-xl p-8">
                <div class="text-center mb-8">
                    <i class="fas fa-server text-5xl text-purple-500 mb-4"></i>
                    <h1 class="text-3xl font-bold">Login</h1>
                    <p class="text-gray-400 mt-2">Masuk ke akun Anda</p>
                </div>
                
                <form action="/login" method="POST">
                    <div class="mb-4">
                        <label class="block text-gray-300 mb-2">Username</label>
                        <input type="text" name="username" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                    </div>
                    
                    <div class="mb-6">
                        <label class="block text-gray-300 mb-2">Password</label>
                        <input type="password" name="password" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                    </div>
                    
                    <button type="submit" class="btn-login w-full py-3 rounded-lg font-semibold transition-all duration-300">
                        <i class="fas fa-sign-in-alt mr-2"></i> Login
                    </button>
                </form>
                
                <div class="mt-6 text-center">
                    <p class="text-gray-400">Belum punya akun? 
                        <a href="/register" class="text-purple-400 hover:text-purple-300">Daftar di sini</a>
                    </p>
                </div>
                
                <div id="message" class="mt-4 p-3 rounded-lg hidden"></div>
            </div>
            
            <script>
                const urlParams = new URLSearchParams(window.location.search);
                const message = urlParams.get('message');
                if (message) {
                    const div = document.getElementById('message');
                    div.className = message.includes('success') ? 
                        'mt-4 p-3 rounded-lg bg-green-900 text-green-300' : 
                        'mt-4 p-3 rounded-lg bg-red-900 text-red-300';
                    div.textContent = decodeURIComponent(message);
                    div.classList.remove('hidden');
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
        const user = users.find(u => u.username === username);
        
        if (!user) {
            return res.redirect('/login?message=Username%20tidak%20ditemukan');
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.redirect('/login?message=Password%20salah');
        }
        
        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
        };
        
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Login error:', error);
        res.redirect('/login?message=Terjadi%20kesalahan%20sistem');
    }
});

app.get('/register', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Register - Panel Pterodactyl</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body {
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .register-box {
                    background: rgba(30, 41, 59, 0.8);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    width: 100%;
                    max-width: 400px;
                }
                .btn-register {
                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                }
                .btn-register:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
                }
            </style>
        </head>
        <body>
            <div class="register-box rounded-xl p-8">
                <div class="text-center mb-8">
                    <i class="fas fa-user-plus text-5xl text-purple-500 mb-4"></i>
                    <h1 class="text-3xl font-bold">Register</h1>
                    <p class="text-gray-400 mt-2">Buat akun baru</p>
                </div>
                
                <form action="/register" method="POST" onsubmit="return validateForm()">
                    <div class="mb-4">
                        <label class="block text-gray-300 mb-2">Username</label>
                        <input type="text" name="username" id="username" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                        <p class="text-sm text-gray-400 mt-1">Minimal 3 karakter</p>
                    </div>
                    
                    <div class="mb-4">
                        <label class="block text-gray-300 mb-2">Email</label>
                        <input type="email" name="email" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                    </div>
                    
                    <div class="mb-4">
                        <label class="block text-gray-300 mb-2">Password</label>
                        <input type="password" name="password" id="password" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                        <p class="text-sm text-gray-400 mt-1">Minimal 5 karakter</p>
                    </div>
                    
                    <div class="mb-6">
                        <label class="block text-gray-300 mb-2">Confirm Password</label>
                        <input type="password" name="confirmPassword" id="confirmPassword" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500">
                    </div>
                    
                    <button type="submit" class="btn-register w-full py-3 rounded-lg font-semibold transition-all duration-300">
                        <i class="fas fa-user-plus mr-2"></i> Register
                    </button>
                </form>
                
                <div class="mt-6 text-center">
                    <p class="text-gray-400">Sudah punya akun? 
                        <a href="/login" class="text-purple-400 hover:text-purple-300">Login di sini</a>
                    </p>
                </div>
                
                <div id="message" class="mt-4 p-3 rounded-lg hidden"></div>
            </div>
            
            <script>
                function validateForm() {
                    const username = document.getElementById('username').value;
                    const password = document.getElementById('password').value;
                    const confirmPassword = document.getElementById('confirmPassword').value;
                    
                    if (username.length < 3) {
                        showMessage('Username minimal 3 karakter', 'error');
                        return false;
                    }
                    
                    if (password.length < 5) {
                        showMessage('Password minimal 5 karakter', 'error');
                        return false;
                    }
                    
                    if (password !== confirmPassword) {
                        showMessage('Password tidak cocok', 'error');
                        return false;
                    }
                    
                    return true;
                }
                
                function showMessage(text, type) {
                    const div = document.getElementById('message');
                    div.className = type === 'error' ? 
                        'mt-4 p-3 rounded-lg bg-red-900 text-red-300' : 
                        'mt-4 p-3 rounded-lg bg-green-900 text-green-300';
                    div.textContent = text;
                    div.classList.remove('hidden');
                }
                
                const urlParams = new URLSearchParams(window.location.search);
                const message = urlParams.get('message');
                if (message) {
                    showMessage(decodeURIComponent(message), 
                        message.includes('success') ? 'success' : 'error');
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/register', async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    
    if (password.length < 5) {
        return res.redirect('/register?message=Password%20minimal%205%20karakter');
    }
    
    if (password !== confirmPassword) {
        return res.redirect('/register?message=Password%20tidak%20cocok');
    }
    
    if (username.length < 3) {
        return res.redirect('/register?message=Username%20minimal%203%20karakter');
    }
    
    try {
        const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
        
        if (users.find(u => u.username === username)) {
            return res.redirect('/register?message=Username%20sudah%20digunakan');
        }
        
        if (users.find(u => u.email === email)) {
            return res.redirect('/register?message=Email%20sudah%20digunakan');
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = 'user-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        
        const newUser = {
            id: userId,
            username: username,
            email: email,
            password: hashedPassword,
            role: 'user',
            createdAt: new Date().toISOString()
        };
        
        users.push(newUser);
        await fs.writeFile(usersPath, JSON.stringify(users, null, 2));
        
        await sendTelegramNotification(
            `👤 USER BARU TERDAFTAR\n` +
            `Username: ${username}\n` +
            `Email: ${email}\n` +
            `Waktu: ${new Date().toLocaleString('id-ID')}`
        );
        
        res.redirect('/login?message=Registrasi%20berhasil%2C%20silahkan%20login');
    } catch (error) {
        console.error('Register error:', error);
        res.redirect('/register?message=Terjadi%20kesalahan%20sistem');
    }
});

app.get('/pricing', async (req, res) => {
    const prices = settings.pricing;
    
    res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Pricing - Panel Pterodactyl</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body {
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                    color: #e2e8f0;
                    min-height: 100vh;
                }
                .price-card {
                    background: rgba(30, 41, 59, 0.7);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    transition: all 0.3s ease;
                }
                .price-card:hover {
                    transform: translateY(-10px);
                    border-color: #8b5cf6;
                    box-shadow: 0 20px 40px rgba(139, 92, 246, 0.2);
                }
                .btn-order {
                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                }
                .btn-order:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
                }
                .nav-glass {
                    background: rgba(30, 41, 59, 0.8);
                    backdrop-filter: blur(10px);
                }
            </style>
        </head>
        <body>
            <nav class="nav-glass fixed w-full z-50 py-4 px-6">
                <div class="container mx-auto flex justify-between items-center">
                    <div class="text-2xl font-bold">
                        <i class="fas fa-server text-purple-500"></i>
                        <span class="ml-2">PteroPanel</span>
                    </div>
                    <div class="space-x-4">
                        <a href="/" class="hover:text-purple-400">Home</a>
                        <a href="/pricing" class="hover:text-purple-400">Pricing</a>
                        ${req.session.user ? 
                            `<a href="/dashboard" class="hover:text-purple-400">Dashboard</a>
                             <a href="/logout" class="btn-order px-4 py-2 rounded-lg">Logout</a>` :
                            `<a href="/login" class="btn-order px-4 py-2 rounded-lg">Login</a>`
                        }
                    </div>
                </div>
            </nav>

            <main class="pt-24 pb-16 px-4">
                <div class="container mx-auto">
                    <div class="text-center mb-12">
                        <h1 class="text-4xl font-bold mb-4">Pricing Plans</h1>
                        <p class="text-gray-300 text-lg">Pilih paket yang sesuai dengan kebutuhan Anda</p>
                    </div>
                    
                    <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-6xl mx-auto">
                        ${Object.entries(prices).map(([plan, price], index) => `
                            <div class="price-card rounded-xl p-6 ${index === 3 ? 'ring-2 ring-purple-500' : ''}">
                                <div class="text-center mb-6">
                                    <div class="text-3xl font-bold mb-2">${plan.toUpperCase()}</div>
                                    <div class="text-4xl font-bold text-purple-400 mb-2">Rp${price.toLocaleString('id-ID')}</div>
                                    <div class="text-gray-400">per bulan</div>
                                </div>
                                
                                <ul class="space-y-3 mb-8">
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>RAM ${plan === 'unlimited' ? 'Unlimited' : plan}</span>
                                    </li>
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>Disk ${plan === 'unlimited' ? 'Unlimited' : plan}</span>
                                    </li>
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>CPU ${plan === '1gb' || plan === '2gb' ? '40%' : 
                                               plan === '3gb' || plan === '4gb' ? '60%' : 
                                               plan === '5gb' || plan === '6gb' ? '80%' :
                                               plan === '7gb' || plan === '8gb' ? '100%' :
                                               plan === '9gb' || plan === '10gb' ? '120%' : 'Unlimited'}</span>
                                    </li>
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>5 Database</span>
                                    </li>
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>5 Backup Slot</span>
                                    </li>
                                    <li class="flex items-center">
                                        <i class="fas fa-check text-green-500 mr-3"></i>
                                        <span>Garansi 30 Hari</span>
                                    </li>
                                </ul>
                                
                                <button onclick="orderPanel('${plan}')" 
                                        class="btn-order w-full py-3 rounded-lg font-semibold transition-all duration-300">
                                    <i class="fas fa-shopping-cart mr-2"></i> Order Sekarang
                                </button>
                            </div>
                        `).join('')}
                    </div>
                    
                    <div class="mt-16 glass rounded-xl p-8 max-w-4xl mx-auto">
                        <h2 class="text-2xl font-bold mb-6 text-center">Informasi Penting</h2>
                        <div class="grid md:grid-cols-2 gap-6">
                            <div>
                                <h3 class="font-bold mb-3 text-purple-400">✅ Yang Anda Dapatkan</h3>
                                <ul class="space-y-2">
                                    <li class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span>Panel kontrol penuh via Pterodactyl</span>
                                    </li>
                                    <li class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span>Server pribadi & legal</span>
                                    </li>
                                    <li class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span>Support 24/7 via Telegram</span>
                                    </li>
                                </ul>
                            </div>
                            <div>
                                <h3 class="font-bold mb-3 text-red-400">❌ Larangan</h3>
                                <ul class="space-y-2">
                                    <li class="flex items-start">
                                        <i class="fas fa-times-circle text-red-500 mt-1 mr-3"></i>
                                        <span>Dilarang menyebar link login</span>
                                    </li>
                                    <li class="flex items-start">
                                        <i class="fas fa-times-circle text-red-500 mt-1 mr-3"></i>
                                        <span>Dilarang digunakan untuk illegal</span>
                                    </li>
                                    <li class="flex items-start">
                                        <i class="fas fa-times-circle text-red-500 mt-1 mr-3"></i>
                                        <span>No DDoS, No Spam</span>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            </main>

            <script>
                function orderPanel(plan) {
                    ${!req.session.user ? 
                        'window.location.href = "/login?message=Silahkan%20login%20terlebih%20dahulu";' : 
                        `window.location.href = "/order/${plan}";`
                    }
                }
                
                const urlParams = new URLSearchParams(window.location.search);
                const message = urlParams.get('message');
                if (message) {
                    alert(decodeURIComponent(message));
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/order/:plan', requireLogin, async (req, res) => {
    const { plan } = req.params;
    const prices = settings.pricing;
    
    if (!prices[plan]) {
        return res.redirect('/pricing?message=Paket%20tidak%20ditemukan');
    }
    
    const price = prices[plan];
    
    res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Order Panel - ${plan.toUpperCase()}</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body {
                    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                    color: #e2e8f0;
                    min-height: 100vh;
                }
                .order-box {
                    background: rgba(30, 41, 59, 0.8);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .btn-pay {
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                }
                .btn-pay:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(16, 185, 129, 0.3);
                }
                .btn-cancel {
                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                }
                .btn-cancel:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 20px rgba(239, 68, 68, 0.3);
                }
                .loading {
                    display: none;
                }
            </style>
        </head>
        <body class="flex items-center justify-center p-4">
            <div class="order-box rounded-xl p-8 w-full max-w-md">
                <div class="text-center mb-8">
                    <div class="w-16 h-16 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-4">
                        <i class="fas fa-shopping-cart text-2xl"></i>
                    </div>
                    <h1 class="text-2xl font-bold mb-2">Order Panel ${plan.toUpperCase()}</h1>
                    <div class="text-3xl font-bold text-purple-400">Rp${price.toLocaleString('id-ID')}</div>
                </div>
                
                <form id="orderForm">
                    <div class="mb-4">
                        <label class="block text-gray-300 mb-2">Username Panel</label>
                        <input type="text" id="panelUsername" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500"
                               placeholder="username_anda">
                        <p class="text-sm text-gray-400 mt-1">Username untuk login ke panel</p>
                    </div>
                    
                    <div class="mb-6">
                        <label class="block text-gray-300 mb-2">Password Panel</label>
                        <input type="password" id="panelPassword" required 
                               class="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-purple-500"
                               placeholder="Minimal 5 karakter">
                    </div>
                    
                    <div class="space-y-4">
                        <button type="submit" class="btn-pay w-full py-3 rounded-lg font-semibold transition-all duration-300">
                            <i class="fas fa-credit-card mr-2"></i> Bayar Sekarang
                        </button>
                        
                        <div id="loading" class="loading text-center">
                            <div class="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500 mb-2"></div>
                            <p class="text-gray-300">Memproses pembayaran...</p>
                        </div>
                        
                        <a href="/pricing" class="btn-cancel w-full py-3 rounded-lg font-semibold transition-all duration-300 block text-center">
                            <i class="fas fa-times mr-2"></i> Batalkan
                        </a>
                    </div>
                </form>
                
                <div id="qrisSection" class="mt-6 hidden">
                    <div class="text-center mb-4">
                        <h3 class="font-bold mb-2">Scan QRIS untuk Pembayaran</h3>
                        <p class="text-sm text-gray-400">Expired dalam 5 menit</p>
                    </div>
                    <img id="qrisImage" src="" alt="QRIS" class="w-48 h-48 mx-auto mb-4">
                    <div id="paymentInfo" class="text-center text-sm space-y-1"></div>
                    <button onclick="checkPayment()" class="mt-4 w-full py-2 bg-blue-600 rounded-lg">
                        <i class="fas fa-sync-alt mr-2"></i> Cek Status Pembayaran
                    </button>
                </div>
                
                <div id="result" class="mt-6 p-4 rounded-lg hidden"></div>
            </div>
            
            <script>
                const orderForm = document.getElementById('orderForm');
                const loading = document.getElementById('loading');
                const qrisSection = document.getElementById('qrisSection');
                const qrisImage = document.getElementById('qrisImage');
                const paymentInfo = document.getElementById('paymentInfo');
                const resultDiv = document.getElementById('result');
                
                let orderId = '';
                let checkInterval = null;
                
                orderForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    
                    const username = document.getElementById('panelUsername').value;
                    const password = document.getElementById('panelPassword').value;
                    
                    if (password.length < 5) {
                        alert('Password minimal 5 karakter');
                        return;
                    }
                    
                    orderForm.style.display = 'none';
                    loading.style.display = 'block';
                    
                    try {
                        const response = await fetch('/api/create-order', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                plan: '${plan}',
                                username: username,
                                password: password
                            })
                        });
                        
                        const data = await response.json();
                        
                        if (!data.success) {
                            throw new Error(data.message || 'Gagal membuat order');
                        }
                        
                        orderId = data.orderId;
                        
                        loading.style.display = 'none';
                        qrisSection.style.display = 'block';
                        
                        qrisImage.src = 'https://quickchart.io/qr?size=300&text=' + 
                            encodeURIComponent(data.qrisNumber);
                        
                        paymentInfo.innerHTML = \`
                            <div>Order ID: <strong>\${data.orderId}</strong></div>
                            <div>Nominal: <strong>Rp\${data.amount.toLocaleString('id-ID')}</strong></div>
                            <div>Fee: <strong>Rp\${data.fee.toLocaleString('id-ID')}</strong></div>
                            <div>Total: <strong>Rp\${data.total.toLocaleString('id-ID')}</strong></div>
                            <div>Expired: <strong>\${data.expiredTime} WIB</strong></div>
                        \`;
                        
                        checkInterval = setInterval(checkPayment, 5000);
                        
                        setTimeout(() => {
                            if (checkInterval) {
                                clearInterval(checkInterval);
                                alert('Waktu pembayaran telah habis');
                                window.location.href = '/pricing';
                            }
                        }, 5 * 60 * 1000);
                        
                    } catch (error) {
                        loading.style.display = 'none';
                        orderForm.style.display = 'block';
                        alert(error.message);
                    }
                });
                
                async function checkPayment() {
                    try {
                        const response = await fetch('/api/check-payment/' + orderId);
                        const data = await response.json();
                        
                        if (data.status === 'completed') {
                            clearInterval(checkInterval);
                            
                            resultDiv.className = 'mt-6 p-4 rounded-lg bg-green-900 text-green-300';
                            resultDiv.innerHTML = \`
                                <div class="text-center">
                                    <i class="fas fa-check-circle text-4xl mb-4"></i>
                                    <h3 class="font-bold text-xl mb-4">Pembayaran Berhasil!</h3>
                                    <div class="text-left space-y-2">
                                        <div><strong>Username:</strong> \${data.panelInfo.username}</div>
                                        <div><strong>Password:</strong> \${data.panelInfo.password}</div>
                                        <div><strong>Login URL:</strong> <a href="\${data.panelInfo.loginUrl}" class="underline">\${data.panelInfo.loginUrl}</a></div>
                                        <div><strong>RAM:</strong> \${data.panelInfo.specs.ram}</div>
                                        <div><strong>CPU:</strong> \${data.panelInfo.specs.cpu}</div>
                                        <div><strong>Disk:</strong> \${data.panelInfo.specs.disk}</div>
                                    </div>
                                    <div class="mt-6">
                                        <a href="/dashboard" class="inline-block px-6 py-2 bg-purple-600 rounded-lg">
                                            Lihat di Dashboard
                                        </a>
                                    </div>
                                </div>
                            \`;
                            resultDiv.style.display = 'block';
                            qrisSection.style.display = 'none';
                            
                        } else if (data.status === 'expired') {
                            clearInterval(checkInterval);
                            alert('Pembayaran expired');
                            window.location.href = '/pricing';
                        }
                    } catch (error) {
                        console.error('Check payment error:', error);
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/api/create-order', requireLogin, async (req, res) => {
    const { plan, username, password } = req.body;
    const prices = settings.pricing;
    
    if (!prices[plan]) {
        return res.json({ success: false, message: 'Paket tidak ditemukan' });
    }
    
    const amount = prices[plan];
    const orderId = `PANEL-${Date.now()}-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
    
    try {
        const paymentData = await createQrisPayment(amount, orderId);
        
        const order = {
            id: orderId,
            userId: req.session.user.id,
            username: req.session.user.username,
            plan: plan,
            panelUsername: username,
            panelPassword: password,
            amount: amount,
            fee: paymentData.fee,
            total: paymentData.total_payment,
            qrisNumber: paymentData.payment_number,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };
        
        const orders = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        orders.push(order);
        await fs.writeFile(ordersPath, JSON.stringify(orders, null, 2));
        
        res.json({
            success: true,
            orderId: orderId,
            amount: amount,
            fee: paymentData.fee,
            total: paymentData.total_payment,
            qrisNumber: paymentData.payment_number,
            expiredTime: new Date(Date.now() + 5 * 60 * 1000).toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'Asia/Jakarta'
            })
        });
        
    } catch (error) {
        console.error('Create order error:', error);
        res.json({ success: false, message: 'Gagal membuat pembayaran' });
    }
});

app.get('/api/check-payment/:orderId', requireLogin, async (req, res) => {
    const { orderId } = req.params;
    
    try {
        const orders = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        const order = orders.find(o => o.id === orderId);
        
        if (!order) {
            return res.json({ status: 'not_found' });
        }
        
        if (new Date() > new Date(order.expiresAt)) {
            order.status = 'expired';
            await fs.writeFile(ordersPath, JSON.stringify(orders, null, 2));
            return res.json({ status: 'expired' });
        }
        
        if (order.status === 'completed') {
            const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
            const panel = panels.find(p => p.username === order.panelUsername);
            return res.json({ status: 'completed', panelInfo: panel });
        }
        
        const paymentStatus = await checkPaymentStatus(orderId, order.amount);
        
        if (paymentStatus?.status === 'completed' && order.status === 'pending') {
            order.status = 'completed';
            order.completedAt = new Date().toISOString();
            await fs.writeFile(ordersPath, JSON.stringify(orders, null, 2));
            
            try {
                const panelInfo = await createPanelAccount(
                    order.plan,
                    order.panelUsername,
                    order.panelPassword,
                    `${order.panelUsername}@gmail.com`
                );
                
                const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
                panels.push(panelInfo);
                await fs.writeFile(panelsPath, JSON.stringify(panels, null, 2));
                
                await sendTelegramNotification(
                    `💰 PEMBAYARAN BERHASIL\n` +
                    `👤 User: ${order.username}\n` +
                    `📦 Plan: ${order.plan}\n` +
                    `💰 Amount: Rp${order.amount.toLocaleString('id-ID')}\n` +
                    `🆔 Order ID: ${orderId}\n` +
                    `⏰ Waktu: ${new Date().toLocaleString('id-ID')}`
                );
                
                return res.json({ status: 'completed', panelInfo: panelInfo });
                
            } catch (panelError) {
                console.error('Panel creation error:', panelError);
                return res.json({ status: 'error', message: 'Gagal membuat panel' });
            }
        }
        
        res.json({ status: 'pending' });
        
    } catch (error) {
        console.error('Check payment error:', error);
        res.json({ status: 'error', message: 'Gagal mengecek status' });
    }
});

app.get('/dashboard', requireLogin, async (req, res) => {
    if (req.session.user.role === 'admin') {
        return res.redirect('/admin/dashboard');
    }
    
    try {
        const orders = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        const userOrders = orders.filter(o => o.userId === req.session.user.id);
        
        const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
        const userPanels = panels.filter(p => 
            userOrders.some(o => o.panelUsername === p.username)
        );
        
        res.send(`
            <!DOCTYPE html>
            <html lang="id">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Dashboard - Panel Pterodactyl</title>
                <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                <style>
                    body {
                        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                        color: #e2e8f0;
                        min-height: 100vh;
                    }
                    .nav-glass {
                        background: rgba(30, 41, 59, 0.8);
                        backdrop-filter: blur(10px);
                    }
                    .card {
                        background: rgba(30, 41, 59, 0.7);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                    }
                    .btn-primary {
                        background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                    }
                    .btn-primary:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 10px 20px rgba(139, 92, 246, 0.3);
                    }
                    .status-pending { color: #f59e0b; }
                    .status-completed { color: #10b981; }
                    .status-expired { color: #ef4444; }
                </style>
            </head>
            <body>
                <nav class="nav-glass fixed w-full z-50 py-4 px-6">
                    <div class="container mx-auto flex justify-between items-center">
                        <div class="text-2xl font-bold">
                            <i class="fas fa-server text-purple-500"></i>
                            <span class="ml-2">PteroPanel</span>
                        </div>
                        <div class="space-x-4">
                            <a href="/" class="hover:text-purple-400">Home</a>
                            <a href="/pricing" class="hover:text-purple-400">Pricing</a>
                            <a href="/dashboard" class="text-purple-400">Dashboard</a>
                            <a href="/logout" class="btn-primary px-4 py-2 rounded-lg">Logout</a>
                        </div>
                    </div>
                </nav>

                <main class="pt-24 pb-16 px-4">
                    <div class="container mx-auto">
                        <div class="mb-8">
                            <h1 class="text-3xl font-bold">Dashboard</h1>
                            <p class="text-gray-400">Selamat datang, ${req.session.user.username}</p>
                        </div>
                        
                        <div class="grid md:grid-cols-3 gap-8 mb-12">
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-purple-400 mb-2">${userPanels.length}</div>
                                <div class="text-gray-300">Panel Aktif</div>
                            </div>
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-green-400 mb-2">
                                    ${userOrders.filter(o => o.status === 'completed').length}
                                </div>
                                <div class="text-gray-300">Order Sukses</div>
                            </div>
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-yellow-400 mb-2">${userOrders.length}</div>
                                <div class="text-gray-300">Total Order</div>
                            </div>
                        </div>
                        
                        <div class="grid lg:grid-cols-2 gap-8">
                            <div>
                                <h2 class="text-2xl font-bold mb-6">Panel Aktif</h2>
                                ${userPanels.length > 0 ? 
                                    userPanels.map(panel => `
                                        <div class="card rounded-xl p-6 mb-4">
                                            <div class="flex justify-between items-start mb-4">
                                                <div>
                                                    <h3 class="font-bold text-lg">${panel.username}</h3>
                                                    <p class="text-gray-400 text-sm">${panel.plan.toUpperCase()}</p>
                                                </div>
                                                <span class="px-3 py-1 bg-green-900 text-green-300 rounded-full text-sm">
                                                    Active
                                                </span>
                                            </div>
                                            <div class="space-y-2 text-sm">
                                                <div><strong>Login:</strong> <a href="${panel.loginUrl}" class="text-purple-400" target="_blank">${panel.loginUrl}</a></div>
                                                <div><strong>Username:</strong> ${panel.username}</div>
                                                <div><strong>Password:</strong> ${panel.password}</div>
                                                <div><strong>Spesifikasi:</strong> ${panel.specs.ram} RAM, ${panel.specs.cpu} CPU, ${panel.specs.disk} Disk</div>
                                                <div><strong>Expires:</strong> ${new Date(panel.expiresAt).toLocaleDateString('id-ID')}</div>
                                            </div>
                                        </div>
                                    `).join('') :
                                    `<div class="card rounded-xl p-8 text-center">
                                        <i class="fas fa-server text-4xl text-gray-600 mb-4"></i>
                                        <p class="text-gray-400">Belum ada panel aktif</p>
                                        <a href="/pricing" class="btn-primary inline-block mt-4 px-6 py-2 rounded-lg">Order Sekarang</a>
                                    </div>`
                                }
                            </div>
                            
                            <div>
                                <h2 class="text-2xl font-bold mb-6">Riwayat Order</h2>
                                ${userOrders.length > 0 ? 
                                    userOrders.map(order => `
                                        <div class="card rounded-xl p-6 mb-4">
                                            <div class="flex justify-between items-start mb-4">
                                                <div>
                                                    <h3 class="font-bold">${order.plan.toUpperCase()}</h3>
                                                    <p class="text-gray-400 text-sm">${order.id}</p>
                                                </div>
                                                <span class="px-3 py-1 rounded-full text-sm status-${order.status}">
                                                    ${order.status === 'pending' ? 'Pending' : 
                                                     order.status === 'completed' ? 'Completed' : 'Expired'}
                                                </span>
                                            </div>
                                            <div class="space-y-2 text-sm">
                                                <div><strong>Tanggal:</strong> ${new Date(order.createdAt).toLocaleString('id-ID')}</div>
                                                <div><strong>Amount:</strong> Rp${order.amount.toLocaleString('id-ID')}</div>
                                                <div><strong>Username Panel:</strong> ${order.panelUsername}</div>
                                                ${order.completedAt ? 
                                                    `<div><strong>Completed:</strong> ${new Date(order.completedAt).toLocaleString('id-ID')}</div>` : 
                                                    order.status === 'pending' ?
                                                    `<div class="text-yellow-400"><i class="fas fa-clock"></i> Menunggu pembayaran (5 menit)</div>` : ''
                                                }
                                            </div>
                                        </div>
                                    `).join('') :
                                    `<div class="card rounded-xl p-8 text-center">
                                        <i class="fas fa-history text-4xl text-gray-600 mb-4"></i>
                                        <p class="text-gray-400">Belum ada riwayat order</p>
                                    </div>`
                                }
                            </div>
                        </div>
                    </div>
                </main>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.redirect('/login?message=Terjadi%20kesalahan');
    }
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
        const orders = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
        
        const totalRevenue = orders
            .filter(o => o.status === 'completed')
            .reduce((sum, o) => sum + o.amount, 0);
        
        res.send(`
            <!DOCTYPE html>
            <html lang="id">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Admin Dashboard - Panel Pterodactyl</title>
                <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                <link rel="stylesheet" href="https://cdn.datatables.net/1.13.6/css/jquery.dataTables.min.css">
                <style>
                    body {
                        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                        color: #e2e8f0;
                        min-height: 100vh;
                    }
                    .nav-glass {
                        background: rgba(30, 41, 59, 0.8);
                        backdrop-filter: blur(10px);
                    }
                    .card {
                        background: rgba(30, 41, 59, 0.7);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                    }
                    .btn-danger {
                        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                    }
                    .btn-danger:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 10px 20px rgba(239, 68, 68, 0.3);
                    }
                    .dataTables_wrapper {
                        color: #e2e8f0 !important;
                    }
                    .dataTables_wrapper .dataTables_filter input {
                        background: #1f2937;
                        color: white;
                        border: 1px solid #4b5563;
                    }
                    table.dataTable {
                        border: 1px solid #374151;
                    }
                    table.dataTable thead th {
                        background: #111827;
                        color: #e2e8f0;
                        border-bottom: 1px solid #374151;
                    }
                    table.dataTable tbody td {
                        border-bottom: 1px solid #374151;
                        background: #1f2937;
                    }
                    table.dataTable tbody tr:hover td {
                        background: #374151;
                    }
                </style>
            </head>
            <body>
                <nav class="nav-glass fixed w-full z-50 py-4 px-6">
                    <div class="container mx-auto flex justify-between items-center">
                        <div class="text-2xl font-bold">
                            <i class="fas fa-crown text-yellow-500"></i>
                            <span class="ml-2">Admin Panel</span>
                        </div>
                        <div class="space-x-4">
                            <a href="/" class="hover:text-purple-400">Home</a>
                            <a href="/admin/dashboard" class="text-purple-400">Dashboard</a>
                            <span class="text-green-400">Admin: ${req.session.user.username}</span>
                            <a href="/logout" class="px-4 py-2 bg-red-600 rounded-lg">Logout</a>
                        </div>
                    </div>
                </nav>

                <main class="pt-24 pb-16 px-4">
                    <div class="container mx-auto">
                        <div class="mb-8">
                            <h1 class="text-3xl font-bold">Admin Dashboard</h1>
                            <p class="text-gray-400">Total Revenue: <strong class="text-green-400">Rp${totalRevenue.toLocaleString('id-ID')}</strong></p>
                        </div>
                        
                        <div class="grid md:grid-cols-4 gap-6 mb-12">
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-purple-400 mb-2">${users.length}</div>
                                <div class="text-gray-300">Total Users</div>
                            </div>
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-green-400 mb-2">
                                    ${orders.filter(o => o.status === 'completed').length}
                                </div>
                                <div class="text-gray-300">Completed Orders</div>
                            </div>
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-yellow-400 mb-2">${panels.length}</div>
                                <div class="text-gray-300">Active Panels</div>
                            </div>
                            <div class="card rounded-xl p-6 text-center">
                                <div class="text-4xl font-bold text-blue-400 mb-2">${orders.length}</div>
                                <div class="text-gray-300">Total Orders</div>
                            </div>
                        </div>
                        
                        <div class="grid lg:grid-cols-2 gap-8 mb-12">
                            <div>
                                <h2 class="text-2xl font-bold mb-6 flex items-center">
                                    <i class="fas fa-list mr-3"></i> Semua Order
                                </h2>
                                <div class="card rounded-xl p-4 overflow-x-auto">
                                    <table id="ordersTable" class="display w-full">
                                        <thead>
                                            <tr>
                                                <th>ID</th>
                                                <th>User</th>
                                                <th>Plan</th>
                                                <th>Amount</th>
                                                <th>Status</th>
                                                <th>Date</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${orders.map(order => `
                                                <tr>
                                                    <td>${order.id}</td>
                                                    <td>${order.username}</td>
                                                    <td>${order.plan}</td>
                                                    <td>Rp${order.amount.toLocaleString('id-ID')}</td>
                                                    <td>
                                                        <span class="px-2 py-1 rounded text-xs 
                                                            ${order.status === 'completed' ? 'bg-green-900 text-green-300' : 
                                                              order.status === 'pending' ? 'bg-yellow-900 text-yellow-300' : 
                                                              'bg-red-900 text-red-300'}">
                                                            ${order.status}
                                                        </span>
                                                    </td>
                                                    <td>${new Date(order.createdAt).toLocaleDateString('id-ID')}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            
                            <div>
                                <h2 class="text-2xl font-bold mb-6 flex items-center">
                                    <i class="fas fa-server mr-3"></i> Semua Panel
                                </h2>
                                <div class="card rounded-xl p-4 overflow-x-auto">
                                    <table id="panelsTable" class="display w-full">
                                        <thead>
                                            <tr>
                                                <th>Username</th>
                                                <th>Plan</th>
                                                <th>Specs</th>
                                                <th>Created</th>
                                                <th>Action</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${panels.map(panel => `
                                                <tr>
                                                    <td>${panel.username}</td>
                                                    <td>${panel.plan}</td>
                                                    <td>${panel.specs.ram} / ${panel.specs.cpu} / ${panel.specs.disk}</td>
                                                    <td>${new Date(panel.createdAt).toLocaleDateString('id-ID')}</td>
                                                    <td>
                                                        <button onclick="deletePanel('${panel.serverId}', '${panel.username}')" 
                                                                class="px-3 py-1 bg-red-600 rounded text-sm hover:bg-red-700">
                                                            <i class="fas fa-trash"></i> Delete
                                                        </button>
                                                    </td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                        
                        <div class="card rounded-xl p-6 mb-8">
                            <h2 class="text-2xl font-bold mb-6 flex items-center">
                                <i class="fas fa-users mr-3"></i> Semua Users
                            </h2>
                            <div class="overflow-x-auto">
                                <table id="usersTable" class="display w-full">
                                    <thead>
                                        <tr>
                                            <th>Username</th>
                                            <th>Email</th>
                                            <th>Role</th>
                                            <th>Created</th>
                                            <th>Orders</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${users.map(user => `
                                            <tr>
                                                <td>${user.username}</td>
                                                <td>${user.email}</td>
                                                <td>
                                                    <span class="px-2 py-1 rounded text-xs 
                                                        ${user.role === 'admin' ? 'bg-purple-900 text-purple-300' : 
                                                          'bg-blue-900 text-blue-300'}">
                                                        ${user.role}
                                                    </span>
                                                </td>
                                                <td>${new Date(user.createdAt).toLocaleDateString('id-ID')}</td>
                                                <td>${orders.filter(o => o.userId === user.id).length}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </main>
                
                <script src="https://code.jquery.com/jquery-3.7.0.min.js"></script>
                <script src="https://cdn.datatables.net/1.13.6/js/jquery.dataTables.min.js"></script>
                <script>
                    $(document).ready(function() {
                        $('#ordersTable').DataTable({
                            pageLength: 10,
                            order: [[5, 'desc']]
                        });
                        
                        $('#panelsTable').DataTable({
                            pageLength: 10,
                            order: [[3, 'desc']]
                        });
                        
                        $('#usersTable').DataTable({
                            pageLength: 10,
                            order: [[3, 'desc']]
                        });
                    });
                    
                    async function deletePanel(serverId, username) {
                        if (!confirm('Hapus panel ' + username + '?')) return;
                        
                        try {
                            const response = await fetch('/api/admin/delete-panel', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    serverId: serverId,
                                    username: username
                                })
                            });
                            
                            const data = await response.json();
                            if (data.success) {
                                alert('Panel berhasil dihapus');
                                location.reload();
                            } else {
                                alert('Gagal menghapus panel: ' + data.message);
                            }
                        } catch (error) {
                            alert('Error: ' + error.message);
                        }
                    }
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.redirect('/login?message=Terjadi%20kesalahan');
    }
});

app.post('/api/admin/delete-panel', requireAdmin, async (req, res) => {
    const { serverId, username } = req.body;
    
    try {
        const response = await axios.delete(
            `${settings.pterodactylDomain}/api/application/servers/${serverId}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.pterodactylApiKey}`
                }
            }
        );
        
        if (response.status === 204) {
            const panels = JSON.parse(await fs.readFile(panelsPath, 'utf8'));
            const updatedPanels = panels.filter(p => p.serverId !== serverId);
            await fs.writeFile(panelsPath, JSON.stringify(updatedPanels, null, 2));
            
            await sendTelegramNotification(
                `🗑️ PANEL DIHAPUS\n` +
                `👤 Username: ${username}\n` +
                `🆔 Server ID: ${serverId}\n` +
                `👨‍💼 Admin: ${req.session.user.username}\n` +
                `⏰ Waktu: ${new Date().toLocaleString('id-ID')}`
            );
            
            res.json({ success: true, message: 'Panel berhasil dihapus' });
        } else {
            res.json({ success: false, message: 'Gagal menghapus panel' });
        }
    } catch (error) {
        console.error('Delete panel error:', error);
        res.json({ success: false, message: error.message });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

cron.schedule('0 * * * *', async () => {
    try {
        const orders = JSON.parse(await fs.readFile(ordersPath, 'utf8'));
        const now = new Date();
        let updated = false;
        
        for (const order of orders) {
            if (order.status === 'pending' && new Date(order.expiresAt) < now) {
                order.status = 'expired';
                updated = true;
            }
        }
        
        if (updated) {
            await fs.writeFile(ordersPath, JSON.stringify(orders, null, 2));
        }
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Access website at: http://localhost:${PORT}`);
    });
});