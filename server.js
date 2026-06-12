// ============================================================
//  CHATBOT BANCAIRE - TEXT-TO-SQL
//  Backend Node.js avec Google Gemini API + SQL Server
//  Auteur : PFE Bancaire
// ============================================================

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const sql       = require('mssql');
const anomalies = require('./anomalies');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
//  SERVIR LE FICHIER chatbot.html sur http://localhost:3000
// ============================================================
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
  },
};

// ============================================================
//  SCHÉMA DU DATAWAREHOUSE
// ============================================================
const DB_SCHEMA = `
==============================
SCHÉMA DU DATAWAREHOUSE
==============================

TABLE dim_carte (
  id_carte            INT PRIMARY KEY,
  num_carte_F002      VARCHAR(255),
  EXPIRY_carte        VARCHAR(200),
  LONGUEUR_BIN        VARCHAR(20),
  PLAFOND_CARTE       VARCHAR(20),
  STATUT_CARTE        VARCHAR(20),       -- '2'=actif, '3'=bloqué, '5'=désactivé, '6'=annulé, '8'=en cours personnalisation
  statut_carte_libele VARCHAR(255),      -- 'Actif', 'Bloquée', 'Annulée', 'Désactivée'
  is_card_renouv      VARCHAR(30),       -- 'Y'=renouvelée, 'N'=non renouvelée
  TCA_LABE            VARCHAR(50),       -- nom/type de carte (ex: 'Sésame', 'Visa')
  TCB_BIN             VARCHAR(50),
  is_prepayed         VARCHAR(20),       -- 'Prépayée' ou NULL = non prépayée
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
  id_resp_trans   INT PRIMARY KEY,
  code_resp_trans VARCHAR(10),
  libelle_resp_trans VARCHAR(50)
)

TABLE fact_transaction (
  id_transaction      INT PRIMARY KEY,
  id_carte            INT,
  id_commercant       INT,
  id_date             INT,
  id_mode_transaction INT,
  id_resp_trans       INT,
  id_type_operation   INT,
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

fact_transaction → dim_carte            : fact_transaction.id_carte           = dim_carte.id_carte
fact_transaction → dim_commercant       : fact_transaction.id_commercant       = dim_commercant.id_commercant
fact_transaction → dim_date             : fact_transaction.id_date             = dim_date.date_id
fact_transaction → dim_type_operation   : fact_transaction.id_type_operation   = dim_type_operation.id_type_operation
fact_transaction → Dim_resp_trans       : fact_transaction.id_resp_trans       = Dim_resp_trans.id_resp_trans
fact_transaction → dim_mode_transaction : fact_transaction.id_mode_transaction = dim_mode_transaction.id_mode_transaction
dim_carte        → dim_compte           : dim_carte.id_compte                  = dim_compte.id_compte
dim_compte       → dim_client           : dim_compte.id_client                 = dim_client.id_client
dim_compte       → dim_agence           : dim_compte.id_agence                 = dim_agence.id_agence
dim_agence       → dim_zone_agence      : dim_agence.id_zone                   = dim_zone_agence.id_zone
fact_ATM_K7      → dim_commercant       : fact_ATM_K7.id_commercant            = dim_commercant.id_commercant

==============================
RÈGLES DE GÉNÉRATION SQL
==============================

R1.  Génère UNIQUEMENT la requête SQL T-SQL brute, sans explication ni commentaire.
R2.  N'ajoute JAMAIS de backticks ni le mot "sql" avant ou après la requête.
R3.  Utilise TOP au lieu de LIMIT, GETDATE() pour la date actuelle.
R4.  Ajoute toujours des alias lisibles sur chaque colonne calculée.
R5.  Ne génère jamais UPDATE, DELETE, DROP, INSERT, ALTER, TRUNCATE, EXEC.
R6.  Si la question est hors sujet → réponds : SELECT 'Question non comprise, expliquez moi un peu plus votre besoin.' AS message

-- STATUTS CARTES (valeurs EXACTES avec majuscules et accents)
R7.  carte active                        → dim_carte.statut_carte_libele = 'Actif'      ET/OU STATUT_CARTE = '2'
R8.  carte bloquée                       → dim_carte.statut_carte_libele = 'Bloquée'    ET/OU STATUT_CARTE = '3'
R9.  carte annulée                       → dim_carte.statut_carte_libele = 'Annulée'    ET/OU STATUT_CARTE = '6'
R10. carte désactivée                    → dim_carte.statut_carte_libele = 'Désactivée' ET/OU STATUT_CARTE = '5'
R11. carte en cours de personnalisation  → dim_carte.STATUT_CARTE = '8'
R12. carte renouvelée                    → dim_carte.is_card_renouv = 'Y'
R13. carte non renouvelée               → dim_carte.is_card_renouv = 'N'
R14. carte prépayée                      → dim_carte.is_prepayed LIKE '%Prépayée%'
R15. carte non prépayée                 → dim_carte.is_prepayed IS NULL OR dim_carte.is_prepayed NOT LIKE '%Prépayée%'
R16. type de carte                       → dim_carte.TCA_LABE LIKE '%<type>%'

-- COMPTES
R17. accéder au compte                  → dim_carte.id_compte = dim_compte.id_compte
R18. statut compte                      → dim_compte.statut_compte
R19. numéro compte                      → dim_compte.num_compte
R20. date création compte               → dim_compte.date_creation_compte
R21. par compte                         → GROUP BY dim_compte.id_compte, dim_compte.num_compte

-- SEGMENTS CLIENTS (dim_compte.statut_compte)
R22. retraite                           → dim_compte.statut_compte = 'RETRAITE'
R23. association                        → dim_compte.statut_compte = 'ASSOCIATION'
R24. groupe                             → dim_compte.statut_compte = 'GROUPES'
R25. PME                                → dim_compte.statut_compte = 'PME'
R26. TRE                                → dim_compte.statut_compte = 'TRE'
R27. corporate                          → dim_compte.statut_compte = 'CORPORATE'
R28. grand public                       → dim_compte.statut_compte = 'GRAND PUBLIC'
R29. jeune                              → dim_compte.statut_compte = 'JEUNE'
R30. salarié                            → dim_compte.statut_compte IN ('SALARIE','SALARIE *','SALARIE **','SALARIE ***')
R31. TPME                               → dim_compte.statut_compte = 'TPME'
R32. profession libérale                → dim_compte.statut_compte = 'PROFESSION LIBERALE'
R33. institutionnel                     → dim_compte.statut_compte = 'INSTITUTIONNEL'
R34. professionnel                      → dim_compte.statut_compte = 'PROFESSIONNEL'
R35. fortunes                           → dim_compte.statut_compte = 'FORTUNES'
R36. grande entreprise                  → dim_compte.statut_compte = 'GRANDE ENTREPRISE'
R37. senior                             → dim_compte.statut_compte = 'SENIOR'

-- CLIENTS
R38. chemin vers client                 → dim_carte → dim_compte → dim_client
     jointures : dim_carte.id_compte = dim_compte.id_compte
                 dim_compte.id_client = dim_client.id_client
R39. nombre de clients distincts        → COUNT(DISTINCT dim_client.id_client) AS nb_clients
R40. par client                         → GROUP BY dim_client.id_client, dim_client.nom_client

-- AGENCES
R41. chemin vers agence                 → fact_transaction → dim_carte → dim_compte → dim_agence
     jointures : fact_transaction.id_carte = dim_carte.id_carte
                 dim_carte.id_compte      = dim_compte.id_compte
                 dim_compte.id_agence     = dim_agence.id_agence
R42. par agence                         → GROUP BY dim_agence.id_agence, dim_agence.agence ORDER BY dim_agence.agence
R43. code agence                        → dim_agence.C_AG
R44. code BCT                           → dim_agence.C_BCT

-- ZONES (jointure OBLIGATOIRE via dim_agence)
R45. chemin vers zone                   → dim_agence → dim_zone_agence
     jointure : dim_agence.id_zone = dim_zone_agence.id_zone
R46. par zone                           → GROUP BY dim_zone_agence.id_zone, dim_zone_agence.zone_agence ORDER BY dim_zone_agence.zone_agence
R47. zone_agence est dans dim_zone_agence, PAS dans dim_agence

-- COMMERÇANTS
R48. Amen Bank / AB                     → dim_commercant.is_AB = 1
R49. ATM                                → dim_commercant.is_ATM = 1
R50. DAB                                → dim_commercant.is_DAB = 1
R51. GAB                                → dim_commercant.is_GAB = 1
R52. Ooredoo                            → dim_commercant.is_recharge_ooredoo = '1'
R53. international                      → dim_commercant.is_international = 1
R54. local                              → dim_commercant.is_international = 0

-- TYPE DE BANQUE
R55. Amen Bank                          → fact_transaction.type_banque = 'AB'
R56. carte étrangère                    → fact_transaction.type_banque = 'ET'
R57. banque locale concurrente          → fact_transaction.type_banque = 'BL'

-- TYPES D'OPÉRATIONS
R58. achat / paiement                   → dim_type_operation.code_operation = '00'
R59. retrait DAB                        → dim_type_operation.code_operation = '01'
R60. authentification                   → dim_type_operation.code_operation = '30'
R61. demande de solde                   → dim_type_operation.code_operation = '31'
R62. demande d'extrait                  → dim_type_operation.code_operation = '38'
R63. dinar express                      → dim_type_operation.code_operation = '43'
R64. jointure obligatoire               → fact_transaction.id_type_operation = dim_type_operation.id_type_operation

-- MODES DE TRANSACTION
R65. sans contact / NFC                 → dim_mode_transaction.card_data_input_mode_f22_9 IN ('E','R')
R66. saisie manuelle                    → dim_mode_transaction.card_data_input_mode_f22_9 = '1'
R67. bande magnétique                   → dim_mode_transaction.card_data_input_mode_f22_9 = '2'
R68. puce / chip / ICC                  → dim_mode_transaction.card_data_input_mode_f22_9 = '5'
R69. e-commerce                         → dim_mode_transaction.card_holder_f22_08 = '9'
R70. titulaire présent                  → dim_mode_transaction.card_holder_f22_08 = '0'
R71. commande téléphonique              → dim_mode_transaction.card_holder_f22_08 = '3'
R72. jointure obligatoire               → fact_transaction.id_mode_transaction = dim_mode_transaction.id_mode_transaction

-- RÉPONSES DE TRANSACTION (table : Dim_resp_trans)
-- jointure : fact_transaction.id_resp_trans = Dim_resp_trans.id_resp_trans
R73. transaction approuvée              → Dim_resp_trans.code_resp_trans = '00N'
R74. transaction annulée / reverse      → Dim_resp_trans.code_resp_trans = '00F'
R75. solde insuffisant                  → Dim_resp_trans.code_resp_trans = '51N'
R76. code PIN incorrect                 → Dim_resp_trans.code_resp_trans = '55N'
R77. erreur système                     → Dim_resp_trans.code_resp_trans = '96N'
R78. carte expirée                      → Dim_resp_trans.code_resp_trans = '54N'
R79. carte inactive                     → Dim_resp_trans.code_resp_trans = '14N'
R80. rejet acquisition                  → Dim_resp_trans.code_resp_trans = '88N'
R81. limite de retrait                  → Dim_resp_trans.code_resp_trans = '61N'
R82. erreur serveur                     → Dim_resp_trans.code_resp_trans = '91N'
R83. tentatives PIN excédées            → Dim_resp_trans.code_resp_trans = '75N'
R84. limite fréquence                   → Dim_resp_trans.code_resp_trans = '65N'
R85. ne pas honorer                     → Dim_resp_trans.code_resp_trans = '05N'
R86. transaction invalide               → Dim_resp_trans.code_resp_trans = '12N'
R87. carte perdue                       → Dim_resp_trans.code_resp_trans = '41N'
R88. carte opposée                      → Dim_resp_trans.code_resp_trans = '04N'
R89. montant invalide                   → Dim_resp_trans.code_resp_trans = '13N'
R90. coupure en cours                   → Dim_resp_trans.code_resp_trans = '90N'
R91. transaction rejetée (non ok)       → Dim_resp_trans.code_resp_trans != '00N'
R92. jointure obligatoire               → fact_transaction.id_resp_trans = Dim_resp_trans.id_resp_trans

-- DEVISES (ISO 4217)
R93.  euro / EUR            → devise_transaction = 978
R94.  dollar / USD          → devise_transaction = 840
R95.  dinar tunisien / TND  → devise_transaction = 788
R96.  dirham / AED          → devise_transaction = 784
R97.  franc CFA             → devise_transaction = 950
R98.  livre sterling / GBP  → devise_transaction = 826
R99.  yuan / CNY            → devise_transaction = 156
R100. ouguiya / MRU         → devise_transaction = 929

-- MONTANTS
R101. total montant          → SUM(ft.montant_autorisation) AS total_montant
R102. montant moyen          → AVG(ft.montant_autorisation) AS montant_moyen
R103. nombre transactions    → COUNT(ft.id_transaction) AS nb_transactions
R104. nombre cartes          → COUNT(*) AS nb_cartes
R105. nombre clients         → COUNT(DISTINCT dim_client.id_client) AS nb_clients

-- DATES
R106. jointure obligatoire   → fact_transaction.id_date = dim_date.date_id
R107. cette année            → dim_date.year = YEAR(GETDATE())
R108. ce mois                → dim_date.month = MONTH(GETDATE()) AND dim_date.year = YEAR(GETDATE())
R109. aujourd'hui            → CAST(dim_date.full_date AS DATE) = CAST(GETDATE() AS DATE)
R110. cette semaine          → dim_date.week_of_year = DATEPART(WEEK, GETDATE()) AND dim_date.year = YEAR(GETDATE())
R111. week-end               → dim_date.is_weekend = 1
R112. par mois               → GROUP BY dim_date.year, dim_date.month, dim_date.month_name ORDER BY dim_date.year, dim_date.month
R113. par année              → GROUP BY dim_date.year ORDER BY dim_date.year
R114. par trimestre          → GROUP BY dim_date.year, dim_date.quarter ORDER BY dim_date.year, dim_date.quarter

-- ATM (fact_ATM_K7)
-- DATE_ATM est VARCHAR → pas de jointure avec dim_date
-- Toujours utiliser MAX(id_ATM) par ATE_NUM pour l'état le plus récent
R115. solde coffre            → SUM(fact_ATM_K7.SOLDE_COFFRE) AS total_coffre
R116. état actuel ATM         → sous-requête MAX(id_ATM) GROUP BY ATE_NUM
R117. lier ATM à commerçant   → fact_ATM_K7.id_commercant = dim_commercant.id_commercant

==============================
EXEMPLES DE REQUÊTES TYPES
==============================

-- Q: "Combien de cartes actives ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Actif'

-- Q: "Où perdons-nous le plus de transactions ?"
SELECT
    dz.zone_agence,
    da.agence,
    COUNT(*) AS nb_rejets,
    CAST(COUNT(*) AS FLOAT) / NULLIF(SUM(COUNT(*)) OVER(PARTITION BY dz.zone_agence), 0) * 100 AS taux_rejet_pct,
    TOP_CAUSE.motif AS principale_cause
FROM fact_transaction ft
JOIN Dim_resp_trans dr       ON ft.id_resp_trans  = dr.id_resp_trans
JOIN dim_carte dc             ON ft.id_carte        = dc.id_carte
JOIN dim_compte dco           ON dc.id_compte       = dco.id_compte
JOIN dim_agence da            ON dco.id_agence      = da.id_agence
JOIN dim_zone_agence dz       ON da.id_zone         = dz.id_zone
OUTER APPLY (
    SELECT TOP 1 dr2.libelle_resp_trans AS motif
    FROM fact_transaction ft2
    JOIN Dim_resp_trans dr2      ON ft2.id_resp_trans  = dr2.id_resp_trans
    JOIN dim_carte dc2            ON ft2.id_carte        = dc2.id_carte
    JOIN dim_compte dco2          ON dc2.id_compte       = dco2.id_compte
    JOIN dim_agence da2           ON dco2.id_agence      = da2.id_agence
    WHERE da2.id_agence = da.id_agence AND dr2.code_resp_trans != '00N'
    GROUP BY dr2.libelle_resp_trans
    ORDER BY COUNT(*) DESC
) TOP_CAUSE
WHERE dr.code_resp_trans != '00N'
GROUP BY dz.zone_agence, da.agence, TOP_CAUSE.motif
ORDER BY nb_rejets DESC

-- Q: "Total des montants des transactions approuvées ce mois ?"
SELECT SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd        ON ft.id_date       = dd.date_id
WHERE dr.code_resp_trans = '00N'
AND dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())

-- Q: "Nombre de transactions par agence cette année ?"
SELECT da.agence, COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_carte dc  ON ft.id_carte    = dc.id_carte
JOIN dim_compte dco ON dc.id_compte  = dco.id_compte
JOIN dim_agence da  ON dco.id_agence = da.id_agence
JOIN dim_date dd    ON ft.id_date    = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY da.agence ORDER BY nb_transactions DESC

-- Q: "Quels ATM faut-il remplir ?"
SELECT atm.ATE_NUM AS numero_atm, dc.nom_commercant AS nom_atm,
       dc.region_commercant AS region, atm.SOLDE_COFFRE AS solde_coffre,
       'À REMPLIR' AS statut
FROM fact_ATM_K7 atm
JOIN (SELECT ATE_NUM, MAX(id_ATM) AS last_id FROM fact_ATM_K7 GROUP BY ATE_NUM) latest
    ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.id_commercant = dc.id_commercant
WHERE atm.SOLDE_COFFRE < 20000
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Taux de rejet global ?"
SELECT
    COUNT(*) AS nb_total,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS nb_rejets,
    CAST(COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100 AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans

-- Q: "Répartition par type de banque ?"
SELECT
    CASE ft.type_banque WHEN 'AB' THEN 'Amen Bank'
                        WHEN 'ET' THEN 'Carte étrangère'
                        WHEN 'BL' THEN 'Banque locale' END AS type_banque,
    COUNT(*) AS nb_transactions,
    SUM(ft.montant_autorisation) AS total_montant,
    CAST(COUNT(*) AS FLOAT) / NULLIF(SUM(COUNT(*)) OVER(), 0) * 100 AS part_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY ft.type_banque ORDER BY nb_transactions DESC
`;

// ============================================================
//  PROMPT SYSTÈME — RÔLE PDG + SCHÉMA
// ============================================================
const SYSTEM_PROMPT = `
# RÔLE & CONTEXTE
Tu es un expert SQL Server senior spécialisé en monétique bancaire, Data Warehouse, Business Intelligence
et pilotage stratégique pour Direction Générale (PDG).
Tu travailles pour le PDG d'une banque tunisienne (Amen Bank).
Le PDG pose des questions métier, stratégiques ou opérationnelles — PAS techniques.
Tu dois transformer chaque question en une requête SQL Server T-SQL STRICTEMENT valide.

# INTERPRÉTATION MÉTIER
"Où perdons-nous le plus de transactions ?"
→ rejets par agence ET zone (jointure dim_agence → dim_zone_agence OBLIGATOIRE)
→ zone_agence est dans dim_zone_agence, JAMAIS dans dim_agence directement
→ classifier les causes, calculer le taux de rejet

"Nos DAB sont-ils alimentés ?"
→ soldes ATM via MAX(id_ATM) par ATE_NUM
→ ATM critique si SOLDE_COFFRE < 20000

"Comment évolue notre activité ?"
→ volume mois actuel vs précédent, montant global, taux réussite, canaux

# RÈGLE CRITIQUE ANTI-ERREUR ZONE
Quand la question concerne les zones ou agences :
- zone_agence → TOUJOURS joindre dim_zone_agence via dim_agence.id_zone = dim_zone_agence.id_zone
- Ne JAMAIS utiliser zone_agence directement depuis dim_agence (colonne inexistante)
- Chemin complet : fact_transaction → dim_carte → dim_compte → dim_agence → dim_zone_agence

# SORTIE ATTENDUE
Répondre UNIQUEMENT avec la requête SQL T-SQL brute.
JAMAIS : backticks, mot "sql", explication, commentaire, texte avant/après.

# RÈGLES ANTI-HALLUCINATION
- Utiliser UNIQUEMENT les tables et colonnes du schéma fourni
- Vérifier chaque jointure avant de l'écrire
- Toujours aliaser les colonnes calculées
- Ne jamais écrire SELECT *

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
  const sqlMajuscule = requeteSQL.toUpperCase();
  return !MOTS_DANGEREUX.some(mot => sqlMajuscule.includes(mot));
}

// ============================================================
//  FONCTION : APPEL GEMINI (normal + correction d'erreur)
// ============================================================
async function appelGemini(promptUtilisateur, sqlErreur = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // Mode correction : envoyer le SQL cassé + l'erreur à Gemini
  const promptFinal = sqlErreur
    ? `La requête SQL suivante a produit une erreur SQL Server :

REQUÊTE INCORRECTE :
${sqlErreur.sql}

MESSAGE D'ERREUR :
${sqlErreur.message}

Corrige cette requête en respectant STRICTEMENT le schéma fourni.
Vérifie toutes les jointures et tous les noms de colonnes.
RAPPEL IMPORTANT : zone_agence est dans dim_zone_agence, pas dans dim_agence.
Jointure obligatoire pour accéder à zone_agence : dim_agence.id_zone = dim_zone_agence.id_zone
Retourne UNIQUEMENT la requête SQL corrigée, sans explication.`
    : promptUtilisateur;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents:           [{ parts: [{ text: promptFinal }] }],
    generationConfig: {
      temperature:     sqlErreur ? 0.0 : 0.1,
      maxOutputTokens: 600,
    }
  };

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!response.ok) {
    const erreur = await response.text();
    throw new Error(`Erreur Gemini API : ${response.status} - ${erreur}`);
  }

  const data = await response.json();
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error("Gemini n'a retourné aucune réponse.");
  }

  return data.candidates[0].content.parts[0].text
    .trim()
    .replace(/```sql/gi, '')
    .replace(/```/g, '')
    .trim();
}

// ============================================================
//  FONCTION : EXÉCUTION SQL SERVER
// ============================================================
async function executerRequete(requeteSQL) {
  let pool;
  try {
    pool = await sql.connect(dbConfig);
    const resultat = await pool.request().query(requeteSQL);
    return {
      lignes:       resultat.recordset,
      nombreLignes: resultat.recordset ? resultat.recordset.length : 0,
    };
  } finally {
    if (pool) await pool.close();
  }
}

// ============================================================
//  ROUTE PRINCIPALE : POST /api/chat  (avec auto-correction)
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ erreur: 'Le champ "prompt" est requis.' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ erreur: 'Le prompt est trop long (maximum 500 caractères).' });
  }

  console.log(`\n[${new Date().toISOString()}] Prompt : "${prompt}"`);

  try {
    // ── TENTATIVE 1 : génération SQL normale ──────────────────
    console.log('→ Appel Gemini (génération)...');
    let requeteSQL = await appelGemini(prompt);
    console.log(`→ SQL généré : ${requeteSQL}`);

    if (!estRequeteSure(requeteSQL)) {
      return res.json({
        succes: true, prompt, sql: null, data: [], nombreLignes: 0,
        message: "Je ne peux pas exécuter ce type d'opération sur la base de données.",
      });
    }

    let lignes, nombreLignes;

    try {
      // ── TENTATIVE 1 : exécution SQL ────────────────────────
      const resultat = await executerRequete(requeteSQL);
      lignes       = resultat.lignes;
      nombreLignes = resultat.nombreLignes;

    } catch (erreurSQL) {
      // ── TENTATIVE 2 : auto-correction par Gemini ──────────
      console.warn(`⚠️ Erreur SQL : ${erreurSQL.message}`);
      console.log('→ Appel Gemini (correction)...');

      try {
        requeteSQL = await appelGemini(prompt, {
          sql:     requeteSQL,
          message: erreurSQL.message,
        });
        console.log(`→ SQL corrigé : ${requeteSQL}`);

        if (!estRequeteSure(requeteSQL)) {
          throw new Error('Requête corrigée non autorisée.');
        }

        const resultat = await executerRequete(requeteSQL);
        lignes       = resultat.lignes;
        nombreLignes = resultat.nombreLignes;

      } catch (erreurCorrection) {
        // ── ÉCHEC FINAL : message poli au PDG ─────────────────
        console.error('❌ Correction échouée :', erreurCorrection.message);
        return res.json({
          succes: true, prompt, sql: null, data: [], nombreLignes: 0,
          message: "Je n'ai pas pu répondre à cette question avec précision. Pourriez-vous la reformuler différemment ? Par exemple en précisant une agence, une période ou un type d'opération.",
        });
      }
    }

    return res.json({
      succes: true, prompt,
      sql:          requeteSQL,
      data:         lignes,
      nombreLignes: nombreLignes,
    });

  } catch (erreur) {
    console.error('❌ Erreur générale :', erreur.message);
    return res.json({
      succes: true, prompt, sql: null, data: [], nombreLignes: 0,
      message: "Je rencontre une difficulté temporaire. Veuillez réessayer dans quelques instants.",
    });
  }
});

// ============================================================
//  ROUTE DE TEST : GET /api/test
// ============================================================
app.get('/api/test', (req, res) => {
  res.json({
    statut:  'OK',
    message: 'Serveur chatbot bancaire opérationnel.',
    heure:   new Date().toISOString(),
    config: {
      geminiConfigured: !!process.env.GEMINI_API_KEY,
      dbConfigured:     !!process.env.DB_SERVER,
    }
  });
});

// ============================================================
//  ROUTE DE TEST DB : GET /api/test-db
// ============================================================
app.get('/api/test-db', async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const resultat = await pool.request().query('SELECT GETDATE() AS heure_serveur');
    await pool.close();
    res.json({
      statut:        'Connexion SQL Server réussie',
      heure_serveur: resultat.recordset[0].heure_serveur,
    });
  } catch (err) {
    res.status(500).json({ statut: 'Échec de connexion', erreur: err.message });
  }
});

// ============================================================
//  ROUTE ALERTES : GET /api/alertes
// ============================================================
app.get('/api/alertes', (req, res) => {
  res.json(anomalies.getAlertes());
});

// ============================================================
//  DÉMARRAGE DU SERVEUR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`  Chatbot Bancaire - Serveur démarré`);
  console.log(`  URL : http://localhost:${PORT}`);
  console.log(`  Test serveur : GET  /api/test`);
  console.log(`  Test base DB : GET  /api/test-db`);
  console.log(`  Chatbot      : POST /api/chat`);
  console.log(`  Alertes      : GET  /api/alertes`);
  console.log('========================================');

  anomalies.demarrerDetection(dbConfig);
});