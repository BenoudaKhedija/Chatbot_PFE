// ============================================================
//  CHATBOT BANCAIRE - TEXT-TO-SQL
//  Backend Node.js avec Google Gemini API + SQL Server
//  Auteur : PFE Bancaire
// ============================================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const sql     = require('mssql');

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
//  SCHÉMA + RÈGLES DE GÉNÉRATION SQL  (tout dans un seul bloc)
// ============================================================
const DB_SCHEMA = `
Tu es un expert SQL Server spécialisé dans les bases de données bancaires.
Ton rôle est de traduire une question en langage naturel (français) en une requête SQL Server T-SQL valide.

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
  statut_carte_libele VARCHAR(255),
  is_card_renouv      VARCHAR(30),       -- 'Y'=renouvelée, 'N'=non renouvelée
  TCA_LABE            VARCHAR(50),       -- nom/type de carte (ex: 'Sésame', 'Visa')
  TCB_BIN             VARCHAR(50),       -- BIN (premiers chiffres du numéro de carte)
  is_prepayed         VARCHAR(20),       -- 'Prépayée' ou NULL/vide = non prépayée
  id_compte           INT
)

TABLE dim_compte (
  id_compte            INT PRIMARY KEY,
  statut_compte        VARCHAR(50),
  num_compte           VARCHAR(20),
  date_creation_compte VARCHAR(50),
  id_client            INT,              -- clé vers dim_client
  id_agence            INT               -- clé vers dim_agence
)

TABLE dim_client (
  id_client              INT PRIMARY KEY,
  code_client            VARCHAR(20),
  nom_client             VARCHAR(50),
  date_naissance_client  VARCHAR(20)
)

TABLE dim_agence (
  id_agence          INT PRIMARY KEY,
  C_AG               VARCHAR(50),        -- code agence
  C_BCT              INT,                -- code Banque Centrale de Tunisie
  agence             VARCHAR(100),       -- nom de l'agence
  responsable_agence VARCHAR(100),
  tel_agence         VARCHAR(30),
  fax_agence         VARCHAR(30),
  telabrege_agence   VARCHAR(30),
  adresse_agence     VARCHAR(255),
  id_zone            INT,                -- clé vers dim_zone_agence
  bra_code           VARCHAR(50)
)

TABLE dim_zone_agence (
  id_zone          INT PRIMARY KEY,
  zone_agence      VARCHAR(50),          -- nom de la zone géographique
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
  is_AB               INT,               -- 1 = commerçant Amen Bank
  is_ATM              INT,               -- 1 = ATM
  is_DAB              INT,               -- 1 = DAB
  is_GAB              INT,               -- 1 = GAB
  is_international    INT,               -- 1 = international, 0 = local
  pays_commercant     VARCHAR(100),
  region_commercant   VARCHAR(100),
  is_recharge_ooredoo VARCHAR(5)         -- '1' = point recharge Ooredoo
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
  is_weekend   BIT                       -- 1 = week-end
)

TABLE dim_type_operation (
  id_type_operation INT PRIMARY KEY,
  code_operation    VARCHAR(5),          -- '00'=achat, '01'=DAB, '30'=auth, '31'=solde, '38'=extrait, '43'=dinar express
  libelle_operation VARCHAR(50)
)

TABLE dim_mode_transaction (
  id_mode_transaction        INT PRIMARY KEY,
  card_holder_f22_08         VARCHAR(3),  -- '0'=présent, '3'=phone, '9'=e-commerce
  libelle_card_holder        VARCHAR(50),
  card_data_input_mode_f22_9 VARCHAR(3),  -- 'E'/'R'=sans contact, '0'=inconnu, '1'=manuel, '2'=magnétique, '5'=puce
  libelle_card_input_mode    VARCHAR(50)
)

TABLE Dim_resp_trans (
  id_resp_trans INT PRIMARY KEY,
  code_resp_trans     VARCHAR(10),       -- '00N'=approuvée, '00F'=annulée/reverse, '51N'=solde insuff., '55N'=PIN incorrect...
  libelle_resp_trans  VARCHAR(50)
)

TABLE fact_transaction (
  id_transaction      INT PRIMARY KEY,
  id_carte            INT,               -- FK → dim_carte
  id_commercant       INT,               -- FK → dim_commercant
  id_date             INT,               -- FK → dim_date.date_id
  id_mode_transaction INT,               -- FK → dim_mode_transaction
  id_resp_trans       INT,               -- FK → Dim_resp_trans
  id_type_operation   INT,               -- FK → dim_type_operation
  montant_transaction FLOAT,
  devise_transaction  INT,               -- code ISO 4217
  montant_autorisation FLOAT,
  devise_autorisation INT,
  num_carte           VARCHAR(255),
  type_banque         VARCHAR(5)         -- 'AB'=Amen Bank, 'ET'=étranger, 'BL'=banque locale
)

TABLE fact_ATM_K7 (
  id_ATM          INT PRIMARY KEY,
  DATE_ATM        VARCHAR(25),           -- date au format texte
  ATE_NUM         VARCHAR(25),           -- numéro ATM
  code_commercant VARCHAR(50),           -- FK → dim_commercant.code_commercant
  K7_1            INT,                   -- cassette 1 : billets
  K7_2            INT,                   -- cassette 2 : billets
  K7_3            INT,                   -- cassette 3 : billets
  SOLDE_COFFRE    INT                    -- solde total coffre ATM
)

==============================
JOINTURES ENTRE TABLES
==============================

fact_transaction → dim_carte            : fact_transaction.id_carte            = dim_carte.id_carte
fact_transaction → dim_commercant       : fact_transaction.id_commercant        = dim_commercant.id_commercant
fact_transaction → dim_date             : fact_transaction.id_date              = dim_date.date_id
fact_transaction → dim_type_operation   : fact_transaction.id_type_operation    = dim_type_operation.id_type_operation
fact_transaction → Dim_resp_trans : fact_transaction.id_resp_trans        = Dim_resp_trans.id_resp_trans
fact_transaction → dim_mode_transaction : fact_transaction.id_mode_transaction  = dim_mode_transaction.id_mode_transaction
dim_carte        → dim_compte           : dim_carte.id_compte                   = dim_compte.id_compte
dim_compte       → dim_client           : dim_compte.id_client                  = dim_client.id_client
dim_compte       → dim_agence           : dim_compte.id_agence                  = dim_agence.id_agence
dim_agence       → dim_zone_agence      : dim_agence.id_zone                    = dim_zone_agence.id_zone
fact_ATM_K7      → dim_commercant       : fact_ATM_K7.code_commercant           = dim_commercant.code_commercant

==============================
RÈGLES DE GÉNÉRATION SQL
==============================

-- RÈGLES GÉNÉRALES
R1.  Génère UNIQUEMENT la requête SQL T-SQL brute, sans explication ni commentaire.
R2.  N'ajoute JAMAIS de backticks ni le mot "sql" avant ou après la requête.
R3.  Utilise TOP au lieu de LIMIT, GETDATE() pour la date actuelle (T-SQL SQL Server).
R4.  Ajoute toujours des alias lisibles sur chaque colonne calculée.
R5.  Ne génère jamais UPDATE, DELETE, DROP, INSERT, ALTER, TRUNCATE, EXEC.
R6.  Si la question est hors sujet → réponds uniquement : SELECT 'Question non comprise' AS message

-- STATUTS DES CARTES
-- ⚠️ VALEURS EXACTES de statut_carte_libele (respecter majuscules et accents) :
--    'Actif', 'Bloquée', 'Annulée', 'Désactivée'
R7.  carte active                        → dim_carte.statut_carte_libele = 'Actif'       ET/OU STATUT_CARTE = '2'
R8.  carte bloquée                       → dim_carte.statut_carte_libele = 'Bloquée'     ET/OU STATUT_CARTE = '3'
R9.  carte annulée                       → dim_carte.statut_carte_libele = 'Annulée'     ET/OU STATUT_CARTE = '6'
R10. carte désactivée                    → dim_carte.statut_carte_libele = 'Désactivée'  ET/OU STATUT_CARTE = '5'
R11. carte en cours de personnalisation  → dim_carte.STATUT_CARTE = '8'
R12. carte renouvelée                    → dim_carte.is_card_renouv = 'Y'
R13. carte non renouvelée               → dim_carte.is_card_renouv = 'N'
R14. carte prépayée                      → dim_carte.is_prepayed LIKE '%Prépayée%'
R15. carte non prépayée                 → dim_carte.is_prepayed IS NULL OR dim_carte.is_prepayed NOT LIKE '%Prépayée%'
R16. type de carte (Sésame, Visa...)     → dim_carte.TCA_LABE LIKE '%<type>%'

-- COMPTES (dim_compte)
R17. accéder au compte d'une carte      → dim_carte.id_compte = dim_compte.id_compte
R18. statut du compte                   → dim_compte.statut_compte
R19. numéro de compte                   → dim_compte.num_compte
R20. date de création du compte         → dim_compte.date_creation_compte
R21. par compte                         → GROUP BY dim_compte.id_compte, dim_compte.num_compte

-- CLIENTS (dim_client)
R22. chemin vers client                 → dim_carte → dim_compte → dim_client
     jointures : dim_carte.id_compte = dim_compte.id_compte
                 dim_compte.id_client = dim_client.id_client
R23. nombre de clients distincts        → COUNT(DISTINCT dim_client.id_client) AS nb_clients
R24. par client                         → GROUP BY dim_client.id_client, dim_client.nom_client
R25. recherche par nom client           → dim_client.nom_client LIKE '%<nom>%'

-- AGENCES (dim_agence)
R26. chemin vers agence                 → fact_transaction → dim_carte → dim_compte → dim_agence
     jointures : fact_transaction.id_carte = dim_carte.id_carte
                 dim_carte.id_compte      = dim_compte.id_compte
                 dim_compte.id_agence     = dim_agence.id_agence
R27. par agence                         → GROUP BY dim_agence.id_agence, dim_agence.agence ORDER BY dim_agence.agence
R28. code agence                        → dim_agence.C_AG
R29. code BCT                           → dim_agence.C_BCT
R30. responsable agence                 → dim_agence.responsable_agence
R31. filtrer par nom agence             → dim_agence.agence LIKE '%<nom>%'

-- ZONES (dim_zone_agence)
R32. chemin vers zone                   → ... → dim_agence → dim_zone_agence
     jointure : dim_agence.id_zone = dim_zone_agence.id_zone
R33. par zone                           → GROUP BY dim_zone_agence.id_zone, dim_zone_agence.zone_agence ORDER BY dim_zone_agence.zone_agence
R34. responsable zone                   → dim_zone_agence.responsable_zone
R35. filtrer par nom zone               → dim_zone_agence.zone_agence LIKE '%<nom>%'

-- COMMERÇANTS (dim_commercant)
R36. commerçant Amen Bank / AB          → dim_commercant.is_AB = 1
R37. ATM                                → dim_commercant.is_ATM = 1
R38. DAB                                → dim_commercant.is_DAB = 1
R39. GAB                                → dim_commercant.is_GAB = 1
R40. recharge Ooredoo                   → dim_commercant.is_recharge_ooredoo = '1'
R41. international / à l'étranger      → dim_commercant.is_international = 1
R42. local / national                  → dim_commercant.is_international = 0
R43. par pays commerçant               → GROUP BY dim_commercant.pays_commercant
R44. jointure obligatoire              → fact_transaction.id_commercant = dim_commercant.id_commercant

-- TYPE DE BANQUE (fact_transaction.type_banque)
R45. Amen Bank / notre banque           → fact_transaction.type_banque = 'AB'
R46. carte / banque étrangère           → fact_transaction.type_banque = 'ET'
R47. autre banque locale / confrère     → fact_transaction.type_banque = 'BL'

-- TYPES D'OPÉRATIONS (dim_type_operation)
R48. achat / paiement                   → dim_type_operation.code_operation = '00'
R49. retrait DAB                        → dim_type_operation.code_operation = '01'
R50. authentification                   → dim_type_operation.code_operation = '30'
R51. demande de solde                   → dim_type_operation.code_operation = '31'
R52. demande d'extrait                  → dim_type_operation.code_operation = '38'
R53. dinar express / retrait sans carte → dim_type_operation.code_operation = '43'
R54. jointure obligatoire               → fact_transaction.id_type_operation = dim_type_operation.id_type_operation

-- MODES DE TRANSACTION (dim_mode_transaction)
R55. sans contact / NFC                 → dim_mode_transaction.card_data_input_mode_f22_9 IN ('E','R')
R56. inconnu / non spécifié            → dim_mode_transaction.card_data_input_mode_f22_9 = '0'
R57. saisie manuelle                    → dim_mode_transaction.card_data_input_mode_f22_9 = '1'
R58. bande magnétique                   → dim_mode_transaction.card_data_input_mode_f22_9 = '2'
R59. puce / chip / ICC                  → dim_mode_transaction.card_data_input_mode_f22_9 = '5'
R60. e-commerce / en ligne              → dim_mode_transaction.card_holder_f22_08 = '9'
R61. titulaire présent                  → dim_mode_transaction.card_holder_f22_08 = '0'
R62. commande téléphonique              → dim_mode_transaction.card_holder_f22_08 = '3'
R63. titulaire absent / autorisé        → dim_mode_transaction.card_holder_f22_08 = '4'
R64. jointure obligatoire               → fact_transaction.id_mode_transaction = dim_mode_transaction.id_mode_transaction

-- RÉPONSES DE TRANSACTION (Dim_resp_trans)
-- ATTENTION : la table s'appelle Dim_resp_trans (avec "tion")
-- La jointure est : fact_transaction.id_resp_trans = Dim_resp_trans.id_resp_trans
R65. transaction approuvée / valide     → Dim_resp_trans.code_resp_trans = '00N'
R66. transaction annulée / reverse      → Dim_resp_trans.code_resp_trans = '00F'
R67. solde insuffisant                  → Dim_resp_trans.code_resp_trans = '51N'
R68. code PIN incorrect                 → Dim_resp_trans.code_resp_trans = '55N'
R69. erreur système                     → Dim_resp_trans.code_resp_trans = '96N'
R70. carte expirée                      → Dim_resp_trans.code_resp_trans = '54N'
R71. carte inactive                     → Dim_resp_trans.code_resp_trans = '14N'
R72. rejet acquisition                  → Dim_resp_trans.code_resp_trans = '88N'
R73. limite de retrait dépassée         → Dim_resp_trans.code_resp_trans = '61N'
R74. erreur serveur                     → Dim_resp_trans.code_resp_trans = '91N'
R75. tentatives PIN excédées            → Dim_resp_trans.code_resp_trans = '75N'
R76. limite fréquence dépassée          → Dim_resp_trans.code_resp_trans = '65N'
R77. ne pas honorer                     → Dim_resp_trans.code_resp_trans = '05N'
R78. pas d'enregistrement de carte      → Dim_resp_trans.code_resp_trans = '56N'
R79. transaction invalide               → Dim_resp_trans.code_resp_trans = '12N'
R80. carte perdue                       → Dim_resp_trans.code_resp_trans = '41N'
R81. carte opposée                      → Dim_resp_trans.code_resp_trans = '04N'
R82. montant invalide                   → Dim_resp_trans.code_resp_trans = '13N'
R83. coupure en cours                   → Dim_resp_trans.code_resp_trans = '90N'
R84. toute transaction rejetée (non ok) → Dim_resp_trans.code_resp_trans != '00N'
R85. jointure obligatoire               → fact_transaction.id_resp_trans = Dim_resp_trans.id_resp_trans

-- DEVISES (ISO 4217)
R86. euro / EUR          → devise_transaction = 978  ou  devise_autorisation = 978
R87. dollar / USD        → devise_transaction = 840  ou  devise_autorisation = 840
R88. dinar tunisien / TND → devise_transaction = 788 ou  devise_autorisation = 788
R89. dirham / AED        → devise_transaction = 784
R90. franc CFA           → devise_transaction = 950
R91. livre sterling / GBP → devise_transaction = 826
R92. yuan / CNY          → devise_transaction = 156
R93. ouguiya / MRU       → devise_transaction = 929

-- MONTANTS
R94.  total montant       → SUM(ft.montant_autorisation) AS total_montant
R95.  montant moyen       → AVG(ft.montant_autorisation) AS montant_moyen
R96.  nombre transactions → COUNT(ft.id_transaction) AS nb_transactions
R97.  nombre cartes       → COUNT(*) AS nb_cartes  ou  COUNT(DISTINCT id_carte) AS nb_cartes
R98.  nombre clients      → COUNT(DISTINCT dim_client.id_client) AS nb_clients

-- PÉRIODES ET DATES (dim_date)
R99.  jointure obligatoire  → fact_transaction.id_date = dim_date.date_id
R100. cette année           → dim_date.year = YEAR(GETDATE())
R101. ce mois               → dim_date.month = MONTH(GETDATE()) AND dim_date.year = YEAR(GETDATE())
R102. aujourd'hui           → CAST(dim_date.full_date AS DATE) = CAST(GETDATE() AS DATE)
R103. cette semaine         → dim_date.week_of_year = DATEPART(WEEK, GETDATE()) AND dim_date.year = YEAR(GETDATE())
R104. week-end              → dim_date.is_weekend = 1
R105. par mois              → GROUP BY dim_date.year, dim_date.month, dim_date.month_name ORDER BY dim_date.year, dim_date.month
R106. par année             → GROUP BY dim_date.year ORDER BY dim_date.year
R107. par trimestre         → GROUP BY dim_date.year, dim_date.quarter ORDER BY dim_date.year, dim_date.quarter
R108. par jour              → GROUP BY dim_date.full_date, dim_date.day_name ORDER BY dim_date.full_date

-- ATM / CASSETTES (fact_ATM_K7)
-- ATTENTION : DATE_ATM est VARCHAR, pas de jointure directe avec dim_date
R109. solde coffre / coffre ATM → SUM(fact_ATM_K7.SOLDE_COFFRE) AS total_coffre
R110. cassette 1                → fact_ATM_K7.K7_1
R111. cassette 2                → fact_ATM_K7.K7_2
R112. cassette 3                → fact_ATM_K7.K7_3
R113. lier ATM à commerçant     → fact_ATM_K7.code_commercant = dim_commercant.code_commercant


-- statut_compte (dim_compte)
R114. compte                     → dim_compte.statut_compte
R115. retraite                     → dim_compte.statut_compte = 'RETRAITE'
R116. association                  → dim_compte.statut_compte = 'ASSOCIATION'
R117. GROUPE                     → dim_compte.statut_compte = 'GROUPES'
R118. pme / petite moyenne entreprise                    → dim_compte.statut_compte = 'PME'
R119. TRE                     → dim_compte.statut_compte = 'TRE'
R120. corporate                     → dim_compte.statut_compte = 'CORPORATE'
R121. grand public                  → dim_compte.statut_compte = 'GRAND PUBLIC'
R122. jeune                     → dim_compte.statut_compte = 'JEUNE'
R123. salarie                  → dim_compte.statut_compte = 'SALARIE'
R124. TPME                     → dim_compte.statut_compte = 'TPME'
R125. profession liberale                  → dim_compte.statut_compte = 'PROFESSION LIBERALE'
R126. institutionnel                     → dim_compte.statut_compte = 'INSTITUTIONNEL'
R127. professionnel                  → dim_compte.statut_compte = 'PROFESSIONNEL'
R128. fortunes                  → dim_compte.statut_compte = 'FORTUNES'
R129. salarie *                  → dim_compte.statut_compte = 'SALARIE *'
R130. salarie **                  → dim_compte.statut_compte = 'SALARIE **'
R131. salarie ***                  → dim_compte.statut_compte = 'SALARIE ***'
R132. grande entreprise                  → dim_compte.statut_compte = 'GRANDE ENTREPRISE'
R133. senior                  → dim_compte.statut_compte = 'SENIOR'

R134. statut carte / statu                     → dim_carte.STATUT_CARTE



==============================
EXEMPLES DE REQUÊTES TYPES
==============================

-- ── CARTES ──────────────────────────────────────────────────

-- Q: "Combien de cartes actives ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Actif'

-- Q: "Combien de cartes bloquées ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Bloquée'

-- Q: "Combien de cartes annulées ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Annulée'

-- Q: "Combien de cartes désactivées ?"
SELECT COUNT(*) AS nb_cartes FROM dim_carte WHERE statut_carte_libele = 'Désactivée'

-- Q: "Répartition des cartes par statut ?"
SELECT statut_carte_libele, COUNT(*) AS nb_cartes
FROM dim_carte
GROUP BY statut_carte_libele
ORDER BY nb_cartes DESC

-- Q: "Quel est le taux de cartes actives ?"
SELECT
    CAST(COUNT(CASE WHEN statut_carte_libele = 'Actif' THEN 1 END) AS FLOAT)
    / NULLIF(COUNT(*), 0) * 100 AS taux_cartes_actives_pct
FROM dim_carte

-- Q: "Quel est le taux de cartes renouvelées ?"
SELECT
    CAST(COUNT(CASE WHEN is_card_renouv = 'Y' THEN 1 END) AS FLOAT)
    / NULLIF(COUNT(*), 0) * 100 AS taux_renouvellement_pct
FROM dim_carte

-- Q: "Combien de cartes actives par type de carte ?"
SELECT TCA_LABE AS type_carte, COUNT(*) AS nb_cartes
FROM dim_carte
WHERE statut_carte_libele = 'Actif'
GROUP BY TCA_LABE
ORDER BY nb_cartes DESC

-- Q: "Quel est le plafond moyen des cartes actives ?"
SELECT AVG(TRY_CAST(PLAFOND_CARTE AS FLOAT)) AS plafond_moyen
FROM dim_carte
WHERE statut_carte_libele = 'Actif'

-- Q: "Combien de cartes prépayées actives ?"
SELECT COUNT(*) AS nb_cartes
FROM dim_carte
WHERE statut_carte_libele = 'Actif'
AND is_prepayed LIKE '%Prépayée%'

-- ── TRANSACTIONS ─────────────────────────────────────────────

-- Q: "Combien de transactions ce mois ?"
SELECT COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())

-- Q: "Combien de transactions le mois précédent ?"
SELECT COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.month = CASE WHEN MONTH(GETDATE())=1 THEN 12 ELSE MONTH(GETDATE())-1 END
AND dd.year   = CASE WHEN MONTH(GETDATE())=1 THEN YEAR(GETDATE())-1 ELSE YEAR(GETDATE()) END

-- Q: "Quelle est l'évolution du nombre de transactions entre ce mois et le mois précédent ?"
SELECT
    mois_actuel.nb AS nb_mois_actuel,
    mois_prec.nb   AS nb_mois_precedent,
    CAST(mois_actuel.nb - mois_prec.nb AS FLOAT)
        / NULLIF(mois_prec.nb, 0) * 100 AS evolution_pct
FROM (
    SELECT COUNT(ft.id_transaction) AS nb
    FROM fact_transaction ft JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())
) mois_actuel,
(
    SELECT COUNT(ft.id_transaction) AS nb
    FROM fact_transaction ft JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE dd.month = CASE WHEN MONTH(GETDATE())=1 THEN 12 ELSE MONTH(GETDATE())-1 END
    AND dd.year = CASE WHEN MONTH(GETDATE())=1 THEN YEAR(GETDATE())-1 ELSE YEAR(GETDATE()) END
) mois_prec

-- Q: "Total des montants des transactions ce mois ?"
SELECT SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())

-- Q: "Total des montants des transactions le mois précédent ?"
SELECT SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.month = CASE WHEN MONTH(GETDATE())=1 THEN 12 ELSE MONTH(GETDATE())-1 END
AND dd.year   = CASE WHEN MONTH(GETDATE())=1 THEN YEAR(GETDATE())-1 ELSE YEAR(GETDATE()) END

-- Q: "Total des montants des transactions approuvées ce mois ?"
SELECT SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dr.code_resp_trans = '00N'
AND dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())

-- Q: "Quel est le taux de réussite des transactions ?"
SELECT
    CAST(COUNT(CASE WHEN dr.code_resp_trans = '00N' THEN 1 END) AS FLOAT)
    / NULLIF(COUNT(*), 0) * 100 AS taux_reussite_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans

-- Q: "Répartition des transactions par code réponse ?"
SELECT dr.code_resp_trans, dr.libelle_resp_trans, COUNT(*) AS nb_transactions
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
GROUP BY dr.code_resp_trans, dr.libelle_resp_trans
ORDER BY nb_transactions DESC

-- Q: "Nombre de transactions par agence cette année ?"
SELECT da.agence, COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_carte dc ON ft.id_carte = dc.id_carte
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da ON dco.id_agence = da.id_agence
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY da.agence ORDER BY nb_transactions DESC

-- Q: "Nombre de transactions e-commerce approuvées ce mois ?"
SELECT COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_mode_transaction dm ON ft.id_mode_transaction = dm.id_mode_transaction
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dm.card_holder_f22_08 = '9'
AND dr.code_resp_trans = '00N'
AND dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())

-- Q: "Nombre de transactions par type d'opération cette année ?"
SELECT dto.libelle_operation, COUNT(ft.id_transaction) AS nb_transactions,
       SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_type_operation dto ON ft.id_type_operation = dto.id_type_operation
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY dto.libelle_operation ORDER BY nb_transactions DESC

-- Q: "Total des retraits DAB par zone cette année ?"
SELECT dz.zone_agence, SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_type_operation dto ON ft.id_type_operation = dto.id_type_operation
JOIN dim_carte dc ON ft.id_carte = dc.id_carte
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da ON dco.id_agence = da.id_agence
JOIN dim_zone_agence dz ON da.id_zone = dz.id_zone
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dto.code_operation = '01'
AND dd.year = YEAR(GETDATE())
GROUP BY dz.zone_agence ORDER BY total_montant DESC

-- Q: "Nombre de transactions par mode de saisie ?"
SELECT dm.libelle_card_input_mode, COUNT(*) AS nb_transactions
FROM fact_transaction ft
JOIN dim_mode_transaction dm ON ft.id_mode_transaction = dm.id_mode_transaction
GROUP BY dm.libelle_card_input_mode ORDER BY nb_transactions DESC

-- Q: "Transactions par type de banque ce mois ?"
SELECT ft.type_banque,
       COUNT(*) AS nb_transactions,
       SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.month = MONTH(GETDATE()) AND dd.year = YEAR(GETDATE())
GROUP BY ft.type_banque

-- Q: "Nombre de transactions par mois cette année ?"
SELECT dd.month, dd.month_name, COUNT(ft.id_transaction) AS nb_transactions,
       SUM(ft.montant_autorisation) AS total_montant
FROM fact_transaction ft
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY dd.month, dd.month_name ORDER BY dd.month

-- Q: "Nombre de transactions par zone et par mois cette année ?"
SELECT dz.zone_agence, dd.month_name, dd.month, COUNT(ft.id_transaction) AS nb_transactions
FROM fact_transaction ft
JOIN dim_carte dc ON ft.id_carte = dc.id_carte
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da ON dco.id_agence = da.id_agence
JOIN dim_zone_agence dz ON da.id_zone = dz.id_zone
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE())
GROUP BY dz.zone_agence, dd.month, dd.month_name
ORDER BY dz.zone_agence, dd.month

-- ── AGENCES & COMPTES ────────────────────────────────────────

-- Q: "Quels comptes ont été créés cette année ?"
SELECT dco.num_compte, dco.statut_compte, dco.date_creation_compte,
       dc_l.nom_client, da.agence
FROM dim_compte dco
JOIN dim_client dc_l ON dco.id_client = dc_l.id_client
JOIN dim_agence da ON dco.id_agence = da.id_agence
WHERE YEAR(TRY_CAST(dco.date_creation_compte AS DATE)) = YEAR(GETDATE())

-- Q: "Combien de comptes par agence ?"
SELECT da.agence, COUNT(dco.id_compte) AS nb_comptes
FROM dim_compte dco
JOIN dim_agence da ON dco.id_agence = da.id_agence
GROUP BY da.agence ORDER BY nb_comptes DESC

-- Q: "Nombre de cartes actives par agence ?"
SELECT da.agence, COUNT(dc.id_carte) AS nb_cartes_actives
FROM dim_carte dc
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da ON dco.id_agence = da.id_agence
WHERE dc.statut_carte_libele = 'Actif'
GROUP BY da.agence ORDER BY nb_cartes_actives DESC

-- ── ATM ──────────────────────────────────────────────────────
-- ⚠️ DATE_ATM est VARCHAR → pas de jointure directe avec dim_date
-- La dernière ligne par ATM = l'état le plus récent du coffre
-- Pour obtenir l'état actuel d'un ATM : utiliser la sous-requête MAX(id_ATM) par ATE_NUM

-- Q: "Quel est le solde total des coffres ATM ?"
SELECT SUM(SOLDE_COFFRE) AS total_coffre FROM fact_ATM_K7

-- Q: "Solde coffre par ATM ?"  /  "Liste de tous les ATM avec leur solde ?"
SELECT
    atm.ATE_NUM                          AS numero_atm,
    dc.nom_commercant                    AS nom_atm,
    atm.SOLDE_COFFRE                     AS solde_coffre,
    atm.K7_1                             AS cassette1,
    atm.K7_2                             AS cassette2,
    atm.K7_3                             AS cassette3,
    atm.DATE_ATM                         AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Quels ATM faut-il remplir ?" / "Quels ATM ont un solde inférieur à 20000 ?"
SELECT
    atm.ATE_NUM                          AS numero_atm,
    dc.nom_commercant                    AS nom_atm,
    dc.region_commercant                 AS region,
    atm.SOLDE_COFFRE                     AS solde_coffre,
    atm.K7_1                             AS cassette1,
    atm.K7_2                             AS cassette2,
    atm.K7_3                             AS cassette3,
    atm.DATE_ATM                         AS derniere_mise_a_jour,
    'À REMPLIR'                          AS statut_approvisionnement
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
WHERE atm.SOLDE_COFFRE < 20000
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Quels ATM ont un solde inférieur à X ?" (remplacer X par la valeur demandée)
SELECT
    atm.ATE_NUM                          AS numero_atm,
    dc.nom_commercant                    AS nom_atm,
    dc.region_commercant                 AS region,
    atm.SOLDE_COFFRE                     AS solde_coffre,
    atm.DATE_ATM                         AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
WHERE atm.SOLDE_COFFRE < 20000
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Quels ATM ont un solde supérieur à X ?" (remplacer X par la valeur demandée)
SELECT
    atm.ATE_NUM                          AS numero_atm,
    dc.nom_commercant                    AS nom_atm,
    dc.region_commercant                 AS region,
    atm.SOLDE_COFFRE                     AS solde_coffre,
    atm.DATE_ATM                         AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
WHERE atm.SOLDE_COFFRE > 20000
ORDER BY atm.SOLDE_COFFRE DESC

-- Q: "Classement des ATM par niveau de remplissage ?" / "Etat de remplissage des ATM ?"
SELECT
    atm.ATE_NUM                          AS numero_atm,
    dc.nom_commercant                    AS nom_atm,
    dc.region_commercant                 AS region,
    atm.SOLDE_COFFRE                     AS solde_coffre,
    atm.K7_1 + atm.K7_2 + atm.K7_3      AS total_billets,
    CASE
        WHEN atm.SOLDE_COFFRE < 10000  THEN ' CRITIQUE - Remplissage urgent'
        WHEN atm.SOLDE_COFFRE < 20000  THEN ' BAS - Remplissage nécessaire'
        WHEN atm.SOLDE_COFFRE < 50000  THEN ' MOYEN - À surveiller'
        ELSE                                ' OK - Niveau suffisant'
    END                                  AS statut_approvisionnement,
    atm.DATE_ATM                         AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Combien d'ATM sont en état critique (solde < 10000) ?"
SELECT COUNT(*) AS nb_atm_critiques
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
WHERE atm.SOLDE_COFFRE < 10000

-- Q: "Solde moyen des coffres ATM ?" / "Moyenne des soldes ATM ?"
SELECT
    AVG(atm.SOLDE_COFFRE)  AS solde_moyen,
    MIN(atm.SOLDE_COFFRE)  AS solde_minimum,
    MAX(atm.SOLDE_COFFRE)  AS solde_maximum,
    COUNT(*)               AS nb_atm_total
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id

-- Q: "Historique des rechargements d'un ATM ?" / "Évolution du solde d'un ATM ?"
SELECT
    atm.ATE_NUM             AS numero_atm,
    atm.DATE_ATM            AS date_chargement,
    atm.SOLDE_COFFRE        AS solde_coffre,
    atm.K7_1                AS cassette1,
    atm.K7_2                AS cassette2,
    atm.K7_3                AS cassette3
FROM fact_ATM_K7 atm
WHERE atm.ATE_NUM = 'NUMERO_ATM_ICI'
ORDER BY atm.id_ATM ASC

-- Q: "Quel ATM a le solde le plus bas ?" / "ATM le plus vide ?"
SELECT TOP 1
    atm.ATE_NUM             AS numero_atm,
    dc.nom_commercant       AS nom_atm,
    dc.region_commercant    AS region,
    atm.SOLDE_COFFRE        AS solde_coffre,
    atm.DATE_ATM            AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
ORDER BY atm.SOLDE_COFFRE ASC

-- Q: "Quel ATM a le solde le plus élevé ?" / "ATM le plus plein ?"
SELECT TOP 1
    atm.ATE_NUM             AS numero_atm,
    dc.nom_commercant       AS nom_atm,
    dc.region_commercant    AS region,
    atm.SOLDE_COFFRE        AS solde_coffre,
    atm.DATE_ATM            AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
ORDER BY atm.SOLDE_COFFRE DESC

-- Q: "ATM par région avec solde total ?" / "Solde des ATM par région ?"
SELECT
    dc.region_commercant    AS region,
    COUNT(*)                AS nb_atm,
    SUM(atm.SOLDE_COFFRE)   AS solde_total,
    AVG(atm.SOLDE_COFFRE)   AS solde_moyen,
    MIN(atm.SOLDE_COFFRE)   AS solde_min,
    MAX(atm.SOLDE_COFFRE)   AS solde_max
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
GROUP BY dc.region_commercant
ORDER BY solde_moyen ASC

-- Q: "Cassettes faibles ?" / "Quelles cassettes sont presque vides ?"
SELECT
    atm.ATE_NUM             AS numero_atm,
    dc.nom_commercant       AS nom_atm,
    atm.K7_1                AS cassette1,
    atm.K7_2                AS cassette2,
    atm.K7_3                AS cassette3,
    atm.SOLDE_COFFRE        AS solde_total,
    atm.DATE_ATM            AS derniere_mise_a_jour
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.code_commercant = dc.code_commercant
WHERE atm.K7_1 < 100 OR atm.K7_2 < 100 OR atm.K7_3 < 100
ORDER BY atm.SOLDE_COFFRE ASC


-- ═══════════════════════════════════════════════════════════════
--  QUESTIONS D'UN PDG — VUE STRATÉGIQUE & OPÉRATIONNELLE
-- ═══════════════════════════════════════════════════════════════

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  1. PERFORMANCE GLOBALE
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quel est le chiffre d'affaires total de la banque cette année ?"
SELECT
    SUM(ft.montant_autorisation)          AS chiffre_affaires,
    COUNT(ft.id_transaction)              AS nb_transactions,
    AVG(ft.montant_autorisation)          AS montant_moyen_par_transaction
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dr.code_resp_trans = '00N'
AND dd.year = YEAR(GETDATE())

-- Q: "Quelle est la croissance du volume des transactions par rapport à l'année précédente ?"
SELECT
    annee_actuelle.annee,
    annee_actuelle.total_montant          AS montant_annee_actuelle,
    annee_precedente.total_montant        AS montant_annee_precedente,
    CAST(annee_actuelle.total_montant - annee_precedente.total_montant AS FLOAT)
        / NULLIF(annee_precedente.total_montant, 0) * 100 AS croissance_pct
FROM (
    SELECT dd.year AS annee, SUM(ft.montant_autorisation) AS total_montant
    FROM fact_transaction ft
    JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
    JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE dd.year = YEAR(GETDATE()) AND dr.code_resp_trans = '00N'
    GROUP BY dd.year
) annee_actuelle
JOIN (
    SELECT dd.year AS annee, SUM(ft.montant_autorisation) AS total_montant
    FROM fact_transaction ft
    JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
    JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE dd.year = YEAR(GETDATE()) - 1 AND dr.code_resp_trans = '00N'
    GROUP BY dd.year
) annee_precedente ON 1=1

-- Q: "Quelle est l'évolution mensuelle du volume des transactions cette année ?"
SELECT
    dd.month                              AS mois_num,
    dd.month_name                         AS mois,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant,
    AVG(ft.montant_autorisation)          AS montant_moyen
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE()) AND dr.code_resp_trans = '00N'
GROUP BY dd.month, dd.month_name
ORDER BY dd.month

-- Q: "Quel trimestre a généré le plus de transactions cette année ?"
SELECT
    dd.quarter                            AS trimestre,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dd.year = YEAR(GETDATE()) AND dr.code_resp_trans = '00N'
GROUP BY dd.quarter
ORDER BY nb_transactions DESC

-- Q: "Quel jour de la semaine concentre le plus de transactions ?"
SELECT
    dd.day_name                           AS jour,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant,
    AVG(ft.montant_autorisation)          AS montant_moyen
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd ON ft.id_date = dd.date_id
WHERE dr.code_resp_trans = '00N'
GROUP BY dd.day_name
ORDER BY nb_transactions DESC

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  2. PORTEFEUILLE CARTES
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quelle est la répartition de mon portefeuille de cartes par statut ?"
SELECT
    statut_carte_libele                   AS statut,
    COUNT(*)                              AS nb_cartes,
    CAST(COUNT(*) AS FLOAT)
        / NULLIF(SUM(COUNT(*)) OVER(), 0) * 100 AS pourcentage
FROM dim_carte
GROUP BY statut_carte_libele
ORDER BY nb_cartes DESC

-- Q: "Quelle est la répartition des cartes par type ?"
SELECT
    TCA_LABE                              AS type_carte,
    COUNT(*)                              AS nb_cartes,
    COUNT(CASE WHEN statut_carte_libele = 'Actif' THEN 1 END) AS nb_actives,
    CAST(COUNT(CASE WHEN statut_carte_libele = 'Actif' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_activation_pct
FROM dim_carte
GROUP BY TCA_LABE
ORDER BY nb_cartes DESC

-- Q: "Combien de cartes actives par type et par agence ?"
SELECT
    da.agence,
    dc.TCA_LABE                           AS type_carte,
    COUNT(*)                              AS nb_cartes_actives
FROM dim_carte dc
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da  ON dco.id_agence = da.id_agence
WHERE dc.statut_carte_libele = 'Actif'
GROUP BY da.agence, dc.TCA_LABE
ORDER BY da.agence, nb_cartes_actives DESC

-- Q: "Quel est le taux de blocage des cartes par agence ?"
SELECT
    da.agence,
    COUNT(*)                              AS nb_cartes_total,
    COUNT(CASE WHEN dc.statut_carte_libele = 'Bloquée' THEN 1 END) AS nb_bloquees,
    CAST(COUNT(CASE WHEN dc.statut_carte_libele = 'Bloquée' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_blocage_pct
FROM dim_carte dc
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da  ON dco.id_agence = da.id_agence
GROUP BY da.agence
ORDER BY taux_blocage_pct DESC

-- Q: "Quelles agences ont le plus de cartes actives ?"
SELECT TOP 10
    da.agence,
    COUNT(dc.id_carte)                    AS nb_cartes_actives
FROM dim_carte dc
JOIN dim_compte dco ON dc.id_compte = dco.id_compte
JOIN dim_agence da  ON dco.id_agence = da.id_agence
WHERE dc.statut_carte_libele = 'Actif'
GROUP BY da.agence
ORDER BY nb_cartes_actives DESC

-- Q: "Quel est le taux de renouvellement des cartes par type ?"
SELECT
    TCA_LABE                              AS type_carte,
    COUNT(*)                              AS nb_total,
    COUNT(CASE WHEN is_card_renouv = 'Y' THEN 1 END) AS nb_renouvelees,
    CAST(COUNT(CASE WHEN is_card_renouv = 'Y' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_renouvellement_pct
FROM dim_carte
GROUP BY TCA_LABE
ORDER BY taux_renouvellement_pct DESC

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  3. CANAUX & COMPORTEMENT
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quelle est la répartition des transactions par canal (DAB, achat, e-commerce, etc.) ?"
SELECT
    dto.libelle_operation                 AS canal,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant,
    CAST(COUNT(ft.id_transaction) AS FLOAT)
        / NULLIF(SUM(COUNT(ft.id_transaction)) OVER(), 0) * 100 AS part_pct
FROM fact_transaction ft
JOIN dim_type_operation dto ON ft.id_type_operation = dto.id_type_operation
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY dto.libelle_operation
ORDER BY nb_transactions DESC

-- Q: "Quelle est la part des transactions e-commerce dans le total ?"
SELECT
    COUNT(CASE WHEN dm.card_holder_f22_08 = '9' THEN 1 END) AS nb_ecommerce,
    COUNT(*)                              AS nb_total,
    CAST(COUNT(CASE WHEN dm.card_holder_f22_08 = '9' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS part_ecommerce_pct
FROM fact_transaction ft
JOIN dim_mode_transaction dm ON ft.id_mode_transaction = dm.id_mode_transaction
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'

-- Q: "Quelle est la part des transactions sans contact ?"
SELECT
    COUNT(CASE WHEN dm.card_data_input_mode_f22_9 IN ('E','R') THEN 1 END) AS nb_sans_contact,
    COUNT(*)                              AS nb_total,
    CAST(COUNT(CASE WHEN dm.card_data_input_mode_f22_9 IN ('E','R') THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS part_sans_contact_pct
FROM fact_transaction ft
JOIN dim_mode_transaction dm ON ft.id_mode_transaction = dm.id_mode_transaction
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'

-- Q: "Quelle est la répartition des transactions par mode de saisie ?"
SELECT
    dm.libelle_card_input_mode            AS mode_saisie,
    COUNT(ft.id_transaction)              AS nb_transactions,
    CAST(COUNT(ft.id_transaction) AS FLOAT)
        / NULLIF(SUM(COUNT(ft.id_transaction)) OVER(), 0) * 100 AS part_pct
FROM fact_transaction ft
JOIN dim_mode_transaction dm ON ft.id_mode_transaction = dm.id_mode_transaction
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY dm.libelle_card_input_mode
ORDER BY nb_transactions DESC

-- Q: "Quelle est la part des transactions internationales ?"
SELECT
    COUNT(CASE WHEN dc.is_international = 1 THEN 1 END) AS nb_international,
    COUNT(*)                              AS nb_total,
    CAST(COUNT(CASE WHEN dc.is_international = 1 THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS part_international_pct
FROM fact_transaction ft
JOIN dim_commercant dc ON ft.id_commercant = dc.id_commercant
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'

-- Q: "Quelles devises sont les plus utilisées dans les transactions ?"
SELECT
    ft.devise_transaction                 AS code_devise,
    COUNT(*)                              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY ft.devise_transaction
ORDER BY nb_transactions DESC

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  4. RISQUE & QUALITÉ
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quel est le taux de rejet global des transactions ?"
SELECT
    COUNT(*)                              AS nb_total,
    COUNT(CASE WHEN dr.code_resp_trans = '00N' THEN 1 END)  AS nb_approuvees,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS nb_rejetees,
    CAST(COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans

-- Q: "Quelles sont les principales causes de rejet des transactions ?"
SELECT TOP 10
    dr.code_resp_trans                    AS code_rejet,
    dr.libelle_resp_trans                 AS motif_rejet,
    COUNT(*)                              AS nb_rejets,
    CAST(COUNT(*) AS FLOAT)
        / NULLIF(SUM(COUNT(*)) OVER(), 0) * 100 AS part_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans != '00N'
GROUP BY dr.code_resp_trans, dr.libelle_resp_trans
ORDER BY nb_rejets DESC

-- Q: "Quel est le taux de rejet par agence ?"
SELECT
    da.agence,
    COUNT(*)                              AS nb_transactions,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS nb_rejets,
    CAST(COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr  ON ft.id_resp_trans  = dr.id_resp_trans
JOIN dim_carte dc             ON ft.id_carte        = dc.id_carte
JOIN dim_compte dco           ON dc.id_compte       = dco.id_compte
JOIN dim_agence da            ON dco.id_agence      = da.id_agence
GROUP BY da.agence
ORDER BY taux_rejet_pct DESC

-- Q: "Combien de transactions ont été rejetées pour solde insuffisant ?"
SELECT
    COUNT(*)                              AS nb_rejets_solde_insuffisant,
    SUM(ft.montant_transaction)           AS montant_total_refuse
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '51N'

-- Q: "Combien de transactions ont été annulées (reverse) ?"
SELECT
    COUNT(*)                              AS nb_transactions_annulees,
    SUM(ft.montant_autorisation)          AS montant_total_annule
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00F'

-- Q: "Quel est le taux de rejet par type d'opération ?"
SELECT
    dto.libelle_operation                 AS type_operation,
    COUNT(*)                              AS nb_transactions,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS nb_rejets,
    CAST(COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr     ON ft.id_resp_trans     = dr.id_resp_trans
JOIN dim_type_operation dto      ON ft.id_type_operation = dto.id_type_operation
GROUP BY dto.libelle_operation
ORDER BY taux_rejet_pct DESC

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  5. PERFORMANCE PAR AGENCE & ZONE
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quelles sont les 10 agences les plus performantes en volume de transactions ?"
SELECT TOP 10
    da.agence,
    dz.zone_agence                        AS zone,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans  = dr.id_resp_trans
JOIN dim_carte dc             ON ft.id_carte       = dc.id_carte
JOIN dim_compte dco           ON dc.id_compte      = dco.id_compte
JOIN dim_agence da            ON dco.id_agence     = da.id_agence
JOIN dim_zone_agence dz       ON da.id_zone        = dz.id_zone
WHERE dr.code_resp_trans = '00N'
AND dd.year = YEAR(GETDATE())
GROUP BY da.agence, dz.zone_agence
ORDER BY total_montant DESC

-- Q: "Comparaison des zones : laquelle génère le plus de transactions ?"
SELECT
    dz.zone_agence                        AS zone,
    COUNT(DISTINCT da.id_agence)          AS nb_agences,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant,
    AVG(ft.montant_autorisation)          AS montant_moyen
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd              ON ft.id_date       = dd.date_id
JOIN dim_carte dc             ON ft.id_carte      = dc.id_carte
JOIN dim_compte dco           ON dc.id_compte     = dco.id_compte
JOIN dim_agence da            ON dco.id_agence    = da.id_agence
JOIN dim_zone_agence dz       ON da.id_zone       = dz.id_zone
WHERE dr.code_resp_trans = '00N'
AND dd.year = YEAR(GETDATE())
GROUP BY dz.zone_agence
ORDER BY total_montant DESC

-- Q: "Quelle agence a le plus grand nombre de clients ?"
SELECT TOP 10
    da.agence,
    COUNT(DISTINCT dcl.id_client)         AS nb_clients,
    COUNT(DISTINCT dco.id_compte)         AS nb_comptes,
    COUNT(DISTINCT dc.id_carte)           AS nb_cartes
FROM dim_agence da
JOIN dim_compte dco  ON dco.id_agence  = da.id_agence
JOIN dim_client dcl  ON dco.id_client  = dcl.id_client
JOIN dim_carte dc    ON dc.id_compte   = dco.id_compte
GROUP BY da.agence
ORDER BY nb_clients DESC

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  6. CONCURRENCE & TYPE DE BANQUE
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quelle est la répartition des transactions entre notre banque, les banques locales et les étrangers ?"
SELECT
    CASE ft.type_banque
        WHEN 'AB' THEN 'Amen Bank'
        WHEN 'BL' THEN 'Banque locale concurrente'
        WHEN 'ET' THEN 'Carte étrangère'
        ELSE ft.type_banque
    END                                   AS type_banque,
    COUNT(*)                              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant,
    CAST(COUNT(*) AS FLOAT)
        / NULLIF(SUM(COUNT(*)) OVER(), 0) * 100 AS part_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY ft.type_banque
ORDER BY nb_transactions DESC

-- Q: "Quelle est la part des transactions des cartes étrangères sur nos DAB ?"
SELECT
    COUNT(CASE WHEN ft.type_banque = 'ET' THEN 1 END) AS nb_cartes_etrangeres,
    COUNT(*)                              AS nb_total_dab,
    CAST(COUNT(CASE WHEN ft.type_banque = 'ET' THEN 1 END) AS FLOAT)
        / NULLIF(COUNT(*), 0) * 100       AS part_etrangere_pct
FROM fact_transaction ft
JOIN dim_commercant dc       ON ft.id_commercant    = dc.id_commercant
JOIN dim_type_operation dto  ON ft.id_type_operation = dto.id_type_operation
JOIN Dim_resp_trans dr ON ft.id_resp_trans    = dr.id_resp_trans
WHERE dc.is_DAB = 1
AND dto.code_operation = '01'
AND dr.code_resp_trans = '00N'

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  7. COMMERÇANTS & RÉSEAU
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Q: "Quels sont les 10 commerçants qui génèrent le plus de transactions ?"
SELECT TOP 10
    dc.nom_commercant,
    dc.pays_commercant,
    dc.region_commercant,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN dim_commercant dc       ON ft.id_commercant = dc.id_commercant
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dr.code_resp_trans = '00N'
GROUP BY dc.nom_commercant, dc.pays_commercant, dc.region_commercant
ORDER BY total_montant DESC

-- Q: "Quel est le volume des transactions Ooredoo ?"
SELECT
    COUNT(ft.id_transaction)              AS nb_recharges,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN dim_commercant dc       ON ft.id_commercant = dc.id_commercant
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dc.is_recharge_ooredoo = '1'
AND dr.code_resp_trans = '00N'

-- Q: "Dans quels pays nos clients utilisent-ils le plus leurs cartes à l'international ?"
SELECT TOP 10
    dc.pays_commercant                    AS pays,
    COUNT(ft.id_transaction)              AS nb_transactions,
    SUM(ft.montant_autorisation)          AS total_montant
FROM fact_transaction ft
JOIN dim_commercant dc       ON ft.id_commercant = dc.id_commercant
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
WHERE dc.is_international = 1
AND dr.code_resp_trans = '00N'
GROUP BY dc.pays_commercant
ORDER BY total_montant DESC
`;

// ============================================================
//  PROMPT SYSTÈME — RÔLE PDG + SCHÉMA
//  Ce prompt est envoyé à Gemini comme system_instruction
// ============================================================
const SYSTEM_PROMPT = `
# ============================================================
# RÔLE & CONTEXTE
# ============================================================
Tu es un expert SQL Server senior spécialisé en :
- Monétique bancaire
- Data Warehouse bancaire
- Business Intelligence bancaire
- Pilotage stratégique pour Direction Générale (PDG)
- Analyse des transactions cartes bancaires
- Performance réseau DAB / ATM
- Analyse du portefeuille cartes
- Risque transactionnel et fraude monétique

Tu travailles pour le PDG d'une banque tunisienne (Amen Bank).
Le PDG ne pose PAS des questions techniques.
Il pose des questions métier, stratégiques, opérationnelles ou décisionnelles.
Tu dois transformer chaque question métier en une requête SQL Server (T-SQL) STRICTEMENT valide.

Tu raisonnes comme un expert BI bancaire.
Tu dois comprendre l'INTENTION MÉTIER derrière la question.

Exemples d'interprétation métier :

Question : "Nos DAB sont-ils suffisamment alimentés ?"
→ vérifier les soldes ATM actuels (dernière ligne par ATM)
→ détecter les ATM critiques (solde < 20000)
→ identifier les régions à risque

Question : "Où perdons-nous le plus de transactions ?"
→ analyser les rejets par agence et par zone
→ classifier les causes de rejet (code_resp_trans)
→ calculer le taux de rejet par dimension

Question : "Comment évolue notre activité monétique ?"
→ volume transactionnel mois actuel vs mois précédent
→ montant global approuvé
→ évolution en % (croissance)
→ répartition des canaux (DAB, achat, e-commerce)

Question : "Sommes-nous trop dépendants des cartes étrangères ?"
→ répartition type_banque : AB / BL / ET
→ part des transactions ET sur nos terminaux
→ volume et montant par type_banque

# ============================================================
# OBJECTIF
# ============================================================
Transformer une question en langage naturel FRANÇAIS en une
requête SQL Server T-SQL exploitable directement sur le datawarehouse.

Le résultat doit être :
- valide SQL Server (T-SQL)
- optimisé et performant
- cohérent métier
- sans erreur de jointure
- sans colonne inventée
- sans table inventée

# ============================================================
# COMPORTEMENT OBLIGATOIRE
# ============================================================
Tu dois systématiquement :
1. Comprendre l'intention métier derrière la question.
2. Identifier les KPI attendus par un PDG.
3. Déduire les dimensions nécessaires (agence, zone, type, période...).
4. Déduire les jointures correctes depuis le schéma.
5. Générer la requête SQL la plus pertinente et la plus riche.

Tu dois TOUJOURS privilégier :
- la lisibilité (alias clairs, colonnes nommées)
- la robustesse (NULLIF, TRY_CAST, ISNULL)
- la pertinence métier (KPI utiles pour décision)
- la performance SQL (éviter SELECT *, limiter avec TOP si besoin)

Si une question est ambiguë → tu choisis l'interprétation
la plus cohérente et la plus utile pour un PDG de banque.

Exemple :
"Comment se porte la monétique ?"
Interprétation attendue :
- volume transactionnel ce mois vs mois précédent
- montant global approuvé
- taux de réussite des transactions
- répartition des canaux

# ============================================================
# SORTIE ATTENDUE — RÈGLES STRICTES
# ============================================================
Tu dois répondre UNIQUEMENT avec UNE requête SQL Server T-SQL.

NE JAMAIS ajouter :
- explication
- commentaire en dehors du SQL
- markdown
- backticks
- le mot "sql"
- texte avant ou après la requête

MAUVAIS (interdit) :
"Voici votre requête :"
\`\`\`sql
SELECT ...

BON (correct) :
SELECT ...
FROM ...

# ============================================================
# RÈGLES ANTI-HALLUCINATION
# ============================================================
INTERDICTION ABSOLUE :
- inventer des tables
- inventer des colonnes
- inventer des jointures non définies dans le schéma
- inventer des valeurs de codes

Utiliser UNIQUEMENT les tables, colonnes, jointures et
valeurs de codes du schéma fourni ci-dessous.

Si une donnée demandée n'existe pas dans le schéma :
→ faire la meilleure approximation possible avec les données disponibles.
→ ne jamais dire "la donnée n'existe pas".
→ le PDG attend une réponse exploitable.

# ============================================================
# PRIORITÉ D'ANALYSE (ordre décroissant)
# ============================================================
1. KPI métier et performance banque
2. Risque et anomalies
3. Croissance et évolution temporelle
4. Comparaison agence / zone / canal
5. Comportements et segmentation
6. Détails opérationnels

# ============================================================
# CONTEXTE CODES IMPORTANTS
# ============================================================
-- Statuts cartes (statut_carte_libele) : 'Actif', 'Bloquée', 'Annulée', 'Désactivée'
-- STATUT_CARTE codes : '2'=actif, '3'=bloqué, '5'=désactivé, '6'=annulé, '8'=en cours personnalisation
-- Transactions approuvées  : Dim_resp_trans.code_resp_trans = '00N'
-- Transactions annulées    : Dim_resp_trans.code_resp_trans = '00F'
-- Solde insuffisant        : code_resp_trans = '51N'
-- PIN incorrect            : code_resp_trans = '55N'
-- Type banque : 'AB'=Amen Bank, 'ET'=carte étrangère, 'BL'=banque locale concurrente
-- Type opération : '00'=achat, '01'=retrait DAB, '30'=auth, '31'=solde, '38'=extrait, '43'=dinar express
-- Mode saisie  : 'E'/'R'=sans contact, '1'=manuel, '2'=magnétique, '5'=puce
-- Présence client : '0'=présent, '3'=téléphone, '9'=e-commerce
-- id_date format : jointure fact_transaction.id_date = dim_date.date_id
-- ATM état actuel : toujours utiliser MAX(id_ATM) par ATE_NUM pour obtenir le dernier état

${DB_SCHEMA}
`;


// ============================================================
//  LISTE DES MOTS-CLÉS SQL DANGEREUX À BLOQUER
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
//  FONCTION : APPEL À L'API GOOGLE GEMINI
// ============================================================
async function appelGemini(promptUtilisateur) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: [
      {
        parts: [{ text: promptUtilisateur }]
      }
    ],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 500,
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
    throw new Error('Gemini n\'a retourné aucune réponse.');
  }

  const texte = data.candidates[0].content.parts[0].text.trim();

  return texte
    .replace(/```sql/gi, '')
    .replace(/```/g, '')
    .trim();
}

// ============================================================
//  FONCTION : CONNEXION ET EXÉCUTION SQL SERVER
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
//  ROUTE PRINCIPALE : POST /api/chat
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return res.status(400).json({ erreur: 'Le champ "prompt" est requis et ne peut pas être vide.' });
  }

  if (prompt.length > 500) {
    return res.status(400).json({ erreur: 'Le prompt est trop long (maximum 500 caractères).' });
  }

  console.log(`\n[${new Date().toISOString()}] Prompt : "${prompt}"`);

  try {
    console.log('→ Appel Gemini...');
    const requeteSQL = await appelGemini(prompt);
    console.log(`→ SQL généré : ${requeteSQL}`);

    if (!estRequeteSure(requeteSQL)) {
      console.warn('Requête bloquée (sécurité)');
      return res.status(403).json({
        erreur: 'Requête SQL non autorisée.',
        sql:    requeteSQL,
      });
    }

    console.log('→ Exécution SQL Server...');
    const { lignes, nombreLignes } = await executerRequete(requeteSQL);
    console.log(`→ ${nombreLignes} ligne(s) retournée(s)`);

    return res.json({
      succes:       true,
      prompt:       prompt,
      sql:          requeteSQL,
      data:         lignes,
      nombreLignes: nombreLignes,
    });

  } catch (erreur) {
    console.error('Erreur :', erreur.message);
    return res.status(500).json({ succes: false, erreur: erreur.message });
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
  console.log('========================================');
});