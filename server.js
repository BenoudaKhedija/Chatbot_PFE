// ============================================================
//  CHATBOT BANCAIRE - TEXT-TO-SQL
//  Backend Node.js avec Google Gemini API + SQL Server
//  Auteur : PFE Bancaire — Version optimisée
// ============================================================

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const sql       = require('mssql');
const anomalies = require('./anomalies');

const app = express();
app.use(cors());
app.use(express.json());

const path = require('path');
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'chatbot.html'));
});

// ============================================================
//  CONFIGURATION SQL SERVER
// ============================================================
const dbConfig = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port:     parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true,
    connectTimeout:         15000,   // ✅ timeout connexion : 15 secondes
    requestTimeout:         120000,  // ✅ timeout requête   : 120 secondes
  },
  pool: {
    max:              10,    // ✅ pool persistant : max 10 connexions simultanées
    min:              2,     // ✅ garder 2 connexions toujours ouvertes
    idleTimeoutMillis:30000, // ✅ fermer connexion inactive après 30s
    acquireTimeoutMillis: 15000, // ✅ timeout pour obtenir une connexion du pool
  },
};

// ============================================================
//  POOL SQL PERSISTANT — une seule connexion réutilisée
//  ✅ Optimisation majeure : évite de se reconnecter à chaque requête
// ============================================================
let poolGlobal = null;

async function getPool() {
  if (poolGlobal && poolGlobal.connected) {
    return poolGlobal;
  }
  console.log('[SQL] Connexion au pool SQL Server...');
  poolGlobal = await sql.connect(dbConfig);
  console.log('[SQL] Pool connecté ✅');

  poolGlobal.on('error', (err) => {
    console.error('[SQL] Erreur pool :', err.message);
    poolGlobal = null; // forcer reconnexion au prochain appel
  });

  return poolGlobal;
}

// ============================================================
//  RATE LIMITING SIMPLE — max 10 requêtes par minute
//  ✅ Protège le quota Gemini contre les abus
// ============================================================
const rateLimiter = {
  compteur:   0,
  resetTime:  Date.now() + 60000,

  verifier() {
    const maintenant = Date.now();
    if (maintenant > this.resetTime) {
      this.compteur  = 0;
      this.resetTime = maintenant + 60000;
    }
    if (this.compteur >= 10) {
      const attente = Math.ceil((this.resetTime - maintenant) / 1000);
      throw new Error(`RATE_LIMIT:${attente}`);
    }
    this.compteur++;
  }
};

// ============================================================
//  CACHE SIMPLE — évite de rappeler Gemini pour la même question
//  ✅ Économise du quota : même question = même réponse instantanée
// ============================================================
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(prompt) {
  return prompt.trim().toLowerCase();
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  // Limiter la taille du cache à 50 entrées
  if (cache.size >= 50) {
    const premiereKey = cache.keys().next().value;
    cache.delete(premiereKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// ============================================================
//  SCHÉMA DU DATAWAREHOUSE
// ============================================================
const DB_SCHEMA = `
==============================
SCHEMA DU DATAWAREHOUSE
==============================

TABLE dim_carte (
  id_carte            INT PRIMARY KEY,
  num_carte_F002      VARCHAR(255),
  EXPIRY_carte        VARCHAR(200),
  LONGUEUR_BIN        VARCHAR(20),
  PLAFOND_CARTE       VARCHAR(20),
  STATUT_CARTE        VARCHAR(20),
  statut_carte_libele VARCHAR(255),
  is_card_renouv      VARCHAR(30),
  TCA_LABE            VARCHAR(50),
  TCB_BIN             VARCHAR(50),
  is_prepayed         VARCHAR(20),
  id_compte           INT
)

TABLE dim_compte (
  id_compte            INT PRIMARY KEY,
  statut_compte        VARCHAR(50),
  num_compte           VARCHAR(20),
  date_creation_compte VARCHAR(50),
  id_client            INT,
  id_agence            INT
)

TABLE dim_client (
  id_client              INT PRIMARY KEY,
  code_client            VARCHAR(20),
  nom_client             VARCHAR(50),
  date_naissance_client  VARCHAR(20)
)

TABLE dim_agence (
  id_agence          INT PRIMARY KEY,
  C_AG               VARCHAR(50),
  C_BCT              INT,
  agence             VARCHAR(100),
  responsable_agence VARCHAR(100),
  tel_agence         VARCHAR(30),
  fax_agence         VARCHAR(30),
  telabrege_agence   VARCHAR(30),
  adresse_agence     VARCHAR(255),
  id_zone            INT,
  bra_code           VARCHAR(50)
)

TABLE dim_zone_agence (
  id_zone          INT PRIMARY KEY,
  zone_agence      VARCHAR(50),
  responsable_zone VARCHAR(50),
  tel_zone         VARCHAR(50),
  fax_zone         VARCHAR(50),
  telabrege_zone   VARCHAR(50),
  adresse_zone     VARCHAR(50)
)

TABLE dim_commercant (
  id_commercant       INT PRIMARY KEY,
  code_commercant     VARCHAR(50),
  nom_commercant      VARCHAR(100),
  is_AB               INT,
  is_ATM              INT,
  is_DAB              INT,
  is_GAB              INT,
  is_international    INT,
  pays_commercant     VARCHAR(100),
  region_commercant   VARCHAR(100),
  is_recharge_ooredoo VARCHAR(5)
)

TABLE dim_date (
  date_id      INT PRIMARY KEY,
  full_date    DATETIME,
  day          INT,
  month        INT,
  year         INT,
  day_name     VARCHAR(20),
  month_name   VARCHAR(20),
  quarter      INT,
  week_of_year INT,
  is_weekend   BIT
)

TABLE dim_type_operation (
  id_type_operation INT PRIMARY KEY,
  code_operation    VARCHAR(5),
  libelle_operation VARCHAR(50)
)

TABLE dim_mode_transaction (
  id_mode_transaction        INT PRIMARY KEY,
  card_holder_f22_08         VARCHAR(3),
  libelle_card_holder        VARCHAR(50),
  card_data_input_mode_f22_9 VARCHAR(3),
  libelle_card_input_mode    VARCHAR(50)
)

TABLE Dim_resp_trans (
  id_resp_trans      INT PRIMARY KEY,
  code_resp_trans    VARCHAR(10),
  libelle_resp_trans VARCHAR(50)
)

TABLE fact_transaction (
  id_transaction       INT PRIMARY KEY,
  id_carte             INT,
  id_commercant        INT,
  id_date              INT,
  id_mode_transaction  INT,
  id_resp_trans        INT,
  id_type_operation    INT,
  montant_transaction  FLOAT,
  devise_transaction   INT,
  montant_autorisation FLOAT,
  devise_autorisation  INT,
  num_carte            VARCHAR(255),
  type_banque          VARCHAR(5)
)

TABLE fact_ATM_K7 (
  id_ATM        INT PRIMARY KEY,
  DATE_ATM      VARCHAR(25),
  ATE_NUM       VARCHAR(25),
  id_commercant INT,
  K7_1          INT,
  K7_2          INT,
  K7_3          INT,
  SOLDE_COFFRE  INT
)

==============================
JOINTURES ENTRE TABLES
==============================

fact_transaction -> dim_carte            : fact_transaction.id_carte           = dim_carte.id_carte
fact_transaction -> dim_commercant       : fact_transaction.id_commercant       = dim_commercant.id_commercant
fact_transaction -> dim_date             : fact_transaction.id_date             = dim_date.date_id
fact_transaction -> dim_type_operation   : fact_transaction.id_type_operation   = dim_type_operation.id_type_operation
fact_transaction -> Dim_resp_trans       : fact_transaction.id_resp_trans       = Dim_resp_trans.id_resp_trans
fact_transaction -> dim_mode_transaction : fact_transaction.id_mode_transaction = dim_mode_transaction.id_mode_transaction
dim_carte        -> dim_compte           : dim_carte.id_compte                  = dim_compte.id_compte
dim_compte       -> dim_client           : dim_compte.id_client                 = dim_client.id_client
dim_compte       -> dim_agence           : dim_compte.id_agence                 = dim_agence.id_agence
dim_agence       -> dim_zone_agence      : dim_agence.id_zone                   = dim_zone_agence.id_zone
fact_ATM_K7      -> dim_commercant       : fact_ATM_K7.id_commercant            = dim_commercant.id_commercant

==============================
REGLES DE GENERATION SQL
==============================

R1.  Genere UNIQUEMENT la requete SQL T-SQL brute, sans explication ni commentaire.
R2.  N'ajoute JAMAIS de backticks ni le mot "sql" avant ou apres la requete.
R3.  Utilise TOP au lieu de LIMIT, GETDATE() pour la date actuelle.
R4.  Ajoute toujours des alias lisibles sur chaque colonne calculee.
R5.  Ne genere jamais UPDATE, DELETE, DROP, INSERT, ALTER, TRUNCATE, EXEC.
R6.  Si la question est hors sujet : SELECT 'Question non comprise' AS message

R7.  carte active        : statut_carte_libele = 'Actif'      ou STATUT_CARTE = '2'
R8.  carte bloquee       : statut_carte_libele = 'Bloquee'    ou STATUT_CARTE = '3'
R9.  carte annulee       : statut_carte_libele = 'Annulee'    ou STATUT_CARTE = '6'
R10. carte desactivee    : statut_carte_libele = 'Desactivee' ou STATUT_CARTE = '5'
R11. carte personnalisation : STATUT_CARTE = '8'
R12. carte renouvelee    : is_card_renouv = 'Y'
R14. carte prepayee      : is_prepayed LIKE '%Prepayee%'
R16. type de carte       : TCA_LABE LIKE '%type%'

R17-R21. COMPTES : dim_carte.id_compte = dim_compte.id_compte
R22. retraite : statut_compte = 'RETRAITE'
R25. PME      : statut_compte = 'PME'
R27. corporate : statut_compte = 'CORPORATE'
R28. grand public : statut_compte = 'GRAND PUBLIC'
R29. jeune : statut_compte = 'JEUNE'
R30. salarie : statut_compte IN ('SALARIE','SALARIE *','SALARIE **','SALARIE ***')

R41. chemin agence : fact_transaction -> dim_carte -> dim_compte -> dim_agence
R45. ZONE : dim_agence.id_zone = dim_zone_agence.id_zone (OBLIGATOIRE)
R47. zone_agence est dans dim_zone_agence, PAS dans dim_agence

R55. Amen Bank   : type_banque = 'AB'
R56. etranger    : type_banque = 'ET'
R57. banque locale : type_banque = 'BL'

R58. achat : code_operation = '00'
R59. retrait DAB : code_operation = '01'
R63. dinar express : code_operation = '43'

R65. sans contact : card_data_input_mode_f22_9 IN ('E','R')
R69. e-commerce : card_holder_f22_08 = '9'

R73. approuvee : code_resp_trans = '00N'
R74. annulee   : code_resp_trans = '00F'
R75. solde insuffisant : code_resp_trans = '51N'
R76. PIN incorrect : code_resp_trans = '55N'
R91. rejetee : code_resp_trans != '00N'

R101. montant total : SUM(ft.montant_autorisation) AS total_montant
R103. nb transactions : COUNT(ft.id_transaction) AS nb_transactions
R116. ATM etat actuel : MAX(id_ATM) GROUP BY ATE_NUM

==============================
EXEMPLES DE REQUETES TYPES
==============================

-- Q: "Combien de cartes actives ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Actif'

-- Q: "Nombre de transactions par agence cette annee ?"
SELECT da.agence, COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_carte dc   ON ft.id_carte    = dc.id_carte
JOIN dim_compte dco ON dc.id_compte   = dco.id_compte
JOIN dim_agence da  ON dco.id_agence  = da.id_agence
JOIN dim_date dd    ON ft.id_date     = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY da.agence ORDER BY nb_transactions DESC

-- Q: "Quels ATM faut-il remplir ?"
SELECT atm.ATE_NUM AS numero_atm, dc.nom_commercant AS nom_atm,
       atm.SOLDE_COFFRE AS solde_coffre
FROM fact_ATM_K7 atm
JOIN (SELECT ATE_NUM, MAX(id_ATM) AS last_id FROM fact_ATM_K7 GROUP BY ATE_NUM) latest
    ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.id_commercant = dc.id_commercant
WHERE atm.SOLDE_COFFRE < 20000
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Taux de rejet global ?"
SELECT COUNT(*) AS nb_total,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS nb_rejets,
    CAST(COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100 AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
`;

// ============================================================
//  PROMPT SYSTÈME
// ============================================================
const SYSTEM_PROMPT = `
# ROLE
Tu es un expert SQL Server specialise en monetique bancaire pour le PDG d'Amen Bank Tunisie.
Transforme chaque question metier en requete SQL Server T-SQL valide.

# REGLES CRITIQUES
- zone_agence est dans dim_zone_agence UNIQUEMENT (jamais dans dim_agence)
- Chemin zone : fact_transaction -> dim_carte -> dim_compte -> dim_agence -> dim_zone_agence
- Jointure zone OBLIGATOIRE : dim_agence.id_zone = dim_zone_agence.id_zone
- meilleur / top / classement -> TOP 10 avec ORDER BY DESC (jamais TOP 1 sauf si explicitement demande)
- SORTIE : requete SQL brute UNIQUEMENT, zero texte avant ou apres, zero backtick

# ANTI-HALLUCINATION
Utiliser UNIQUEMENT les tables et colonnes du schema fourni.
Verifier chaque jointure. Aliaser chaque colonne calculee.

${DB_SCHEMA}
`;

// ============================================================
//  MOTS-CLÉS SQL DANGEREUX
// ============================================================
const MOTS_DANGEREUX = [
  'DROP', 'DELETE', 'UPDATE', 'INSERT',
  'ALTER', 'TRUNCATE', 'EXEC', 'EXECUTE',
  'CREATE', 'GRANT', 'REVOKE', 'MERGE',
  'xp_', 'sp_', '/*'
];

function estRequeteSure(requeteSQL) {
  return !MOTS_DANGEREUX.some(mot => requeteSQL.toUpperCase().includes(mot));
}
// ============================================================
//  APPEL GROQ
// ============================================================
const MODELES_GROQ = [
  'llama-3.3-70b-versatile'
];

async function appelGroqAvecModele(modele, promptFinal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: modele,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: promptFinal
          }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const erreur = await response.text();

      if (response.status === 429) throw new Error('QUOTA_EXPIRE');
      if (response.status >= 500) throw new Error('GROQ_INDISPONIBLE');

      console.error('Erreur Groq :', erreur);
      throw new Error(`Groq ${response.status}`);
    }

    const data = await response.json();

    const texte = data?.choices?.[0]?.message?.content;
    if (!texte) throw new Error('GROQ_INDISPONIBLE');

    return texte
      .trim()
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .trim();

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('GROQ_TIMEOUT');
    throw err;
  }
}

async function appelGroq(promptUtilisateur, sqlErreur = null) {
  const promptFinal = sqlErreur
    ? `Requete SQL incorrecte :
${sqlErreur.sql}

Erreur SQL Server :
${sqlErreur.message}

Corrige UNIQUEMENT la requete. Zero explication. Verifie jointures et colonnes.
RAPPEL : zone_agence est dans dim_zone_agence (dim_agence.id_zone = dim_zone_agence.id_zone)
RAPPEL : date_creation_compte est VARCHAR, utiliser TRY_CAST ou YEAR(TRY_CAST(date_creation_compte AS DATE))`
    : promptUtilisateur;

  let derniereErreur = null;

  for (const modele of MODELES_GROQ) {
    try {
      console.log(`→ Essai modèle Groq : ${modele}`);
      return await appelGroqAvecModele(modele, promptFinal);
    } catch (err) {
      derniereErreur = err;

      if (err.message === 'GROQ_TIMEOUT') {
        console.warn(`⚠️ ${modele} timeout → modèle suivant...`);
        continue;
      }

      if (err.message === 'QUOTA_EXPIRE') {
        console.warn(`⚠️ ${modele} quota épuisé → modèle suivant...`);
        continue;
      }

      if (err.message === 'GROQ_INDISPONIBLE') {
        console.warn(`⚠️ ${modele} indisponible → modèle suivant...`);
        continue;
      }

      throw err;
    }
  }

  const dernierCode = derniereErreur?.message;
  if (dernierCode === 'QUOTA_EXPIRE') {
    throw new Error('QUOTA_TOUS_MODELES');
  }

  throw derniereErreur || new Error('GROQ_INDISPONIBLE');
}

// ============================================================
//  EXÉCUTION SQL avec pool persistant
//  ✅ Optimisation majeure : réutilise la connexion existante
// ============================================================
async function executerRequete(requeteSQL) {
  const pool    = await getPool();
  const resultat = await pool.request().query(requeteSQL);
  return {
    lignes:       resultat.recordset,
    nombreLignes: resultat.recordset?.length || 0,
  };
}

// ============================================================
//  MESSAGE D'ERREUR selon le type
// ============================================================
function messageErreur(code) {
  const messages = {
    QUOTA_EXPIRE:        "Votre quota est consommé, passez à la version premium !",
    QUOTA_TOUS_MODELES:  "Le quota de tous les modèles IA est épuisé. Réessayez demain ou passez à la version premium.",
    GEMINI_TIMEOUT:      "L'assistant met trop de temps à répondre. Veuillez réessayer.",
    GEMINI_INDISPONIBLE: "L'assistant est temporairement indisponible. Réessayez dans quelques minutes.",
    RATE_LIMIT:          null,
  };
  return messages[code] || "Je rencontre une difficulté temporaire. Veuillez réessayer dans quelques instants.";
}

// ============================================================
//  ROUTE PRINCIPALE : POST /api/chat
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ erreur: 'Le champ "prompt" est requis.' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ erreur: 'Le prompt est trop long (maximum 500 caractères).' });
  }

  // ✅ Rate limiting
  try {
    rateLimiter.verifier();
  } catch (err) {
    const [, attente] = err.message.split(':');
    return res.json({
      succes: true, prompt, sql: null, data: [], nombreLignes: 0,
      message: `Trop de questions en peu de temps. Veuillez patienter ${attente || 30} secondes.`,
    });
  }

  console.log(`\n[${new Date().toISOString()}] Prompt : "${prompt}"`);

  // ✅ Vérifier le cache
  const cacheKey    = getCacheKey(prompt);
  const cacheResult = getCache(cacheKey);
  if (cacheResult) {
    console.log('→ Réponse depuis le cache ✅');
    return res.json(cacheResult);
  }

  try {
    // ── TENTATIVE 1 : génération SQL ─────────────────────────
    console.log('→ Appel Gemini...');
    let requeteSQL = await appelGroq(prompt);
    console.log(`→ SQL : ${requeteSQL.substring(0, 100)}...`);

    if (!estRequeteSure(requeteSQL)) {
      return res.json({
        succes: true, prompt, sql: null, data: [], nombreLignes: 0,
        message: "Je ne peux pas exécuter ce type d'opération sur la base de données.",
      });
    }

    let lignes, nombreLignes;

    try {
      const resultat = await executerRequete(requeteSQL);
      lignes         = resultat.lignes;
      nombreLignes   = resultat.nombreLignes;

    } catch (erreurSQL) {
      // ── TENTATIVE 2 : auto-correction ─────────────────────
      console.warn(`⚠️ Erreur SQL : ${erreurSQL.message}`);

      try {
        requeteSQL = await appelGroq(prompt, {
          sql:     requeteSQL,
          message: erreurSQL.message,
        });
        console.log(`→ SQL corrigé : ${requeteSQL.substring(0, 100)}...`);

        if (!estRequeteSure(requeteSQL)) throw new Error('Requête non autorisée.');

        const resultat = await executerRequete(requeteSQL);
        lignes         = resultat.lignes;
        nombreLignes   = resultat.nombreLignes;

      } catch (erreurCorrection) {
        // ✅ QUOTA_EXPIRE correctement propagé depuis la tentative 2
        const code = erreurCorrection.message;
        if (['QUOTA_EXPIRE','QUOTA_TOUS_MODELES','GEMINI_TIMEOUT','GEMINI_INDISPONIBLE'].includes(code)) {
          return res.json({
            succes: true, prompt, sql: null, data: [], nombreLignes: 0,
            message: messageErreur(code),
          });
        }
        console.error('❌ Correction échouée :', erreurCorrection.message);
        return res.json({
          succes: true, prompt, sql: null, data: [], nombreLignes: 0,
          message: "Je n'ai pas pu répondre avec précision. Reformulez en précisant une agence, une période ou un type d'opération.",
        });
      }
    }

    const reponse = {
      succes: true, prompt,
      sql:          requeteSQL,
      data:         lignes,
      nombreLignes: nombreLignes,
    };

    // ✅ Mettre en cache la réponse
    setCache(cacheKey, reponse);

    return res.json(reponse);

  } catch (erreur) {
    console.error('❌ Erreur générale :', erreur.message);
    return res.json({
      succes: true, prompt, sql: null, data: [], nombreLignes: 0,
      message: messageErreur(erreur.message),
    });
  }
});

// ============================================================
//  ROUTE DE TEST
// ============================================================
app.get('/api/test', (req, res) => {
  res.json({
    statut:  'OK',
    message: 'Serveur chatbot bancaire opérationnel.',
    heure:   new Date().toISOString(),
    cache:   `${cache.size} entrée(s)`,
    quota:   `${rateLimiter.compteur}/10 requêtes cette minute`,
   config: {
  groqConfigured: !!process.env.GROQ_API_KEY,
  dbConfigured:   !!process.env.DB_SERVER,
  poolConnected:  !!(poolGlobal?.connected),
}
  });
});

// ============================================================
//  ROUTE DE TEST DB
// ============================================================
app.get('/api/test-db', async (req, res) => {
  try {
    const pool    = await getPool();
    const resultat = await pool.request().query('SELECT GETDATE() AS heure_serveur');
    res.json({
      statut:        'Connexion SQL Server réussie',
      heure_serveur: resultat.recordset[0].heure_serveur,
      pool:          'persistant ✅',
    });
  } catch (err) {
    res.status(500).json({ statut: 'Echec de connexion', erreur: err.message });
  }
});

// ============================================================
//  ROUTE ALERTES
// ============================================================
app.get('/api/alertes', (req, res) => {
  res.json(anomalies.getAlertes());
});

// ============================================================
//  DÉMARRAGE DU SERVEUR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('========================================');
  console.log(`  Chatbot Bancaire - Serveur démarré`);
  console.log(`  URL : http://localhost:${PORT}`);
  console.log(`  Test serveur : GET  /api/test`);
  console.log(`  Test base DB : GET  /api/test-db`);
  console.log(`  Chatbot      : POST /api/chat`);
  console.log(`  Alertes      : GET  /api/alertes`);
  console.log('========================================');

  // ✅ Pré-connecter le pool SQL dès le démarrage
  try {
    await getPool();
    console.log('[SQL] Pool pré-connecté au démarrage ✅');
  } catch (err) {
    console.warn('[SQL] Pré-connexion échouée (sera retentée):', err.message);
  }

  anomalies.demarrerDetection(dbConfig);
});