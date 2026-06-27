// ============================================================
//  DÉTECTION D'ANOMALIES AUTOMATIQUE — anomalies.js
//  Tourne en arrière-plan toutes les 5 minutes
//  Interroge le datawarehouse et génère des alertes
// ============================================================

const sql = require('mssql');

// ============================================================
//  SEUILS DE DÉTECTION (modifiables dans .env)
// ============================================================
const SEUILS = {
  ATM_SOLDE_CRITIQUE:   parseInt(process.env.SEUIL_ATM_CRITIQUE)   || 40000,
  ATM_SOLDE_BAS:        parseInt(process.env.SEUIL_ATM_BAS)        || 60000,
  TAUX_REJET_CRITIQUE:  parseFloat(process.env.SEUIL_REJET_CRITIQUE)|| 20.0,
  TAUX_REJET_WARNING:   parseFloat(process.env.SEUIL_REJET_WARNING) || 10.0,
  CHUTE_VOLUME_CRITIQUE:parseFloat(process.env.SEUIL_VOLUME_CRITIQUE)|| 30.0,
  CHUTE_VOLUME_WARNING: parseFloat(process.env.SEUIL_VOLUME_WARNING) || 15.0,
};

// ============================================================
//  ÉTAT GLOBAL DES ALERTES (partagé avec server.js)
// ============================================================
let dernieresAlertes = {
  horodatage:    null,
  alertes:       [],
  nbCritiques:   0,
  nbWarnings:    0,
  statut:        'chargement', // 'chargement' | 'ok' | 'anomalie' | 'erreur'
  erreur:        null,
};

// ============================================================
//  REQUÊTES SQL DE DÉTECTION
// ============================================================

// 1. ATM avec solde critique ou bas
const SQL_ATM = `
SELECT
    atm.ATE_NUM                     AS numero_atm,
    dc.nom_commercant               AS nom_atm,
    dc.region_commercant            AS region,
    atm.SOLDE_COFFRE                AS solde,
    atm.DATE_ATM                    AS derniere_maj
FROM fact_ATM_K7 atm
JOIN (
    SELECT ATE_NUM, MAX(id_ATM) AS last_id
    FROM fact_ATM_K7
    GROUP BY ATE_NUM
) latest ON atm.ATE_NUM = latest.ATE_NUM AND atm.id_ATM = latest.last_id
LEFT JOIN dim_commercant dc ON atm.id_commercant = dc.id_commercant
WHERE atm.SOLDE_COFFRE < ${SEUILS.ATM_SOLDE_BAS}
ORDER BY atm.SOLDE_COFFRE ASC
`;

// 2. Taux de rejet aujourd'hui
const SQL_REJET = `
SELECT
    COUNT(*)                                                          AS nb_total,
    COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END)          AS nb_rejets,
    CAST(
        COUNT(CASE WHEN dr.code_resp_trans != '00N' THEN 1 END)
        AS FLOAT) / NULLIF(COUNT(*), 0) * 100                        AS taux_rejet_pct
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd              ON ft.id_date       = dd.date_id
WHERE CAST(dd.full_date AS DATE) = CAST(GETDATE() AS DATE)
`;

// 3. Comparaison volume aujourd'hui vs hier
const SQL_VOLUME = `
SELECT
    aujourd_hui.nb                                                    AS nb_aujourd_hui,
    hier.nb                                                           AS nb_hier,
    CASE
        WHEN hier.nb = 0 THEN 0
        ELSE CAST(aujourd_hui.nb - hier.nb AS FLOAT) / hier.nb * 100
    END                                                               AS evolution_pct
FROM (
    SELECT COUNT(*) AS nb
    FROM fact_transaction ft
    JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE CAST(dd.full_date AS DATE) = CAST(GETDATE() AS DATE)
) aujourd_hui,
(
    SELECT COUNT(*) AS nb
    FROM fact_transaction ft
    JOIN dim_date dd ON ft.id_date = dd.date_id
    WHERE CAST(dd.full_date AS DATE) = CAST(DATEADD(DAY,-1,GETDATE()) AS DATE)
) hier
`;

// 4. Top causes de rejet aujourd'hui
const SQL_CAUSES_REJET = `
SELECT TOP 3
    dr.libelle_resp_trans             AS motif,
    COUNT(*)                          AS nb
FROM fact_transaction ft
JOIN Dim_resp_trans dr ON ft.id_resp_trans = dr.id_resp_trans
JOIN dim_date dd              ON ft.id_date       = dd.date_id
WHERE CAST(dd.full_date AS DATE) = CAST(GETDATE() AS DATE)
AND dr.code_resp_trans != '00N'
GROUP BY dr.libelle_resp_trans
ORDER BY nb DESC
`;

// ============================================================
//  FONCTION PRINCIPALE D'ANALYSE
// ============================================================
async function analyserAnomalies(dbConfig) {
  const alertes = [];

  try {
    const pool = await sql.connect(dbConfig);

    // ── ANALYSE ATM ──────────────────────────────────────────
    try {
      const resATM = await pool.request().query(SQL_ATM);
      const atms   = resATM.recordset;

      atms.forEach(atm => {
        const solde  = atm.solde || 0;
        const nom    = atm.nom_atm || atm.numero_atm;
        const region = atm.region  || '';

        if (solde < SEUILS.ATM_SOLDE_CRITIQUE) {
          alertes.push({
            niveau:  'critique',
            icone:   '🔴',
            titre:   `ATM critique : ${nom}`,
            detail:  `Solde ${solde.toLocaleString('fr-TN')} DT${region ? ' — ' + region : ''} — remplissage urgent`,
            valeur:  solde,
            categorie: 'atm',
          });
        }
      });
    } catch (e) {
      console.warn('[Anomalies] ATM query skipped:', e.message);
    }

    // ── ANALYSE TAUX DE REJET ────────────────────────────────
    try {
      const resRejet = await pool.request().query(SQL_REJET);
      const r        = resRejet.recordset[0];
      if (r && r.nb_total > 0) {
        const taux = parseFloat(r.taux_rejet_pct || 0).toFixed(1);

        if (r.taux_rejet_pct >= SEUILS.TAUX_REJET_CRITIQUE) {
          alertes.push({
            niveau:   'critique',
            icone:    '🔴',
            titre:    `Taux de rejet critique : ${taux}%`,
            detail:   `${r.nb_rejets} transactions rejetées sur ${r.nb_total} aujourd'hui`,
            valeur:   r.taux_rejet_pct,
            categorie:'rejet',
          });
        } else if (r.taux_rejet_pct >= SEUILS.TAUX_REJET_WARNING) {
          alertes.push({
            niveau:   'warning',
            icone:    '🟠',
            titre:    `Taux de rejet élevé : ${taux}%`,
            detail:   `${r.nb_rejets} transactions rejetées sur ${r.nb_total} aujourd'hui`,
            valeur:   r.taux_rejet_pct,
            categorie:'rejet',
          });
        }

        // Ajouter les causes si taux anormal
        if (r.taux_rejet_pct >= SEUILS.TAUX_REJET_WARNING) {
          try {
            const resCauses = await pool.request().query(SQL_CAUSES_REJET);
            if (resCauses.recordset.length > 0) {
              const causes = resCauses.recordset
                .map(c => `${c.motif} (${c.nb})`)
                .join(', ');
              alertes.push({
                niveau:   'info',
                icone:    'ℹ️',
                titre:    'Principales causes de rejet',
                detail:   causes,
                valeur:   0,
                categorie:'rejet_detail',
              });
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[Anomalies] Rejet query skipped:', e.message);
    }

    // ── ANALYSE VOLUME ───────────────────────────────────────
    try {
      const resVol = await pool.request().query(SQL_VOLUME);
      const v      = resVol.recordset[0];
      if (v && v.nb_hier > 0) {
        const evolution = parseFloat(v.evolution_pct || 0).toFixed(1);
        const signe     = v.evolution_pct >= 0 ? '+' : '';

        if (v.evolution_pct <= -SEUILS.CHUTE_VOLUME_CRITIQUE) {
          alertes.push({
            niveau:   'critique',
            icone:    '🔴',
            titre:    `Chute du volume : ${signe}${evolution}%`,
            detail:   `${v.nb_aujourd_hui} transactions aujourd'hui vs ${v.nb_hier} hier`,
            valeur:   v.evolution_pct,
            categorie:'volume',
          });
        } else if (v.evolution_pct <= -SEUILS.CHUTE_VOLUME_WARNING) {
          alertes.push({
            niveau:   'warning',
            icone:    '🟠',
            titre:    `Baisse du volume : ${signe}${evolution}%`,
            detail:   `${v.nb_aujourd_hui} transactions aujourd'hui vs ${v.nb_hier} hier`,
            valeur:   v.evolution_pct,
            categorie:'volume',
          });
        } else if (v.evolution_pct >= 20) {
          alertes.push({
            niveau:   'info',
            icone:    '🟢',
            titre:    `Forte hausse du volume : ${signe}${evolution}%`,
            detail:   `${v.nb_aujourd_hui} transactions aujourd'hui vs ${v.nb_hier} hier`,
            valeur:   v.evolution_pct,
            categorie:'volume',
          });
        }
      }
    } catch (e) {
      console.warn('[Anomalies] Volume query skipped:', e.message);
    }

    await pool.close();

    // ── MISE À JOUR ÉTAT GLOBAL ───────────────────────────────
    const nbCritiques = alertes.filter(a => a.niveau === 'critique').length;
    const nbWarnings  = alertes.filter(a => a.niveau === 'warning').length;

    dernieresAlertes = {
      horodatage:  new Date().toISOString(),
      alertes,
      nbCritiques,
      nbWarnings,
      statut:      nbCritiques > 0 ? 'critique'
                 : nbWarnings  > 0 ? 'warning'
                 : 'ok',
      erreur:      null,
    };

    const emoji = nbCritiques > 0 ? '🔴' : nbWarnings > 0 ? '🟠' : '🟢';
    console.log(`[Anomalies ${new Date().toLocaleTimeString('fr-TN')}] ${emoji} ${nbCritiques} critique(s), ${nbWarnings} avertissement(s)`);

  } catch (erreur) {
    console.error('[Anomalies] Erreur analyse:', erreur.message);
    dernieresAlertes = {
      ...dernieresAlertes,
      horodatage: new Date().toISOString(),
      statut:     'erreur',
      erreur:     erreur.message,
    };
  }
}

// ============================================================
//  DÉMARRAGE DU SCHEDULER
// ============================================================
function demarrerDetection(dbConfig) {
  const INTERVALLE_MS = parseInt(process.env.ANOMALIE_INTERVALLE_MIN || 5) * 60 * 1000;

  console.log(`[Anomalies] Démarrage — analyse toutes les ${INTERVALLE_MS / 60000} min`);

  // Première analyse immédiate au démarrage
  analyserAnomalies(dbConfig);

  // Puis répétition périodique
  setInterval(() => analyserAnomalies(dbConfig), INTERVALLE_MS);
}

// ============================================================
//  EXPORT
// ============================================================
module.exports = {
  demarrerDetection,
  getAlertes: () => dernieresAlertes,
};
