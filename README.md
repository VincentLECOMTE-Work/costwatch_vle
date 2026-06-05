# Costwatch

Costwatch fournit un tableau de bord FinOps pour suivre et analyser les coûts AWS.

## Démarrage rapide

### Version standard locale

Cette copie publique part de la version standard qui tourne en Docker sous le projet `costwatch`.
Par defaut, l'API lit les donnees deja presentes en PostgreSQL et bloque les routes qui declencheraient des appels AWS live.

```bash
cp .env.example .env
cp api/src/accounts-config.sample.json api/src/accounts-config.json
# Renseigner au minimum POSTGRES_PASSWORD dans .env.
docker compose --env-file .env up -d --build db api web
```

URL locale:

- Web: http://localhost:8080
- API: http://localhost:8081

Les variables importantes cote API sont `DATA_FROM=LOCAL_DB`, `AWS_LIVE_ENABLED=false`, `AWS_EC2_METADATA_DISABLED=true` et `ACCOUNT_NAME_SOURCE=org,alias`.

### Confidentialite

Ne committez pas les fichiers locaux suivants:

- `.env`
- `api/src/accounts-config.json`
- `api/src/account-aliases.json`
- toute cle AWS, tout token, tout mot de passe et tout identifiant de compte AWS reel

Les fichiers `*.sample.json` et `.env.example` ne contiennent que des placeholders. Remplissez les vraies valeurs uniquement dans les copies locales ignorees par Git.

### Insights FinOps

L'onglet `Insights FinOps` ajoute des analyses basées uniquement sur la DB:

- tendances coûts, moyenne mobile et projection de fin de mois depuis `cost_daily`,
- anomalies par compte/service/région vs période précédente,
- Action Center avec priorité, impact estimé, preuve, statut et snooze 7/30 jours,
- drilldown interactif sur anomalie, service, compte ou bucket avec évolution journalière et comparaison période précédente,
- forecast avancé fin de mois par compte/service, tendance 7 jours, écart vs M-1 et dépassement attendu,
- snapshots EC2 exacts depuis la DB quand le scheduler horaire optionnel est activé,
- snapshots d'inventaire EBS avec taille totale, IOPS, throughput et coût mensuel estimé,
- concentration des dépenses par service et par compte,
- répartition compte/service et heatmap service/jour,
- croissance S3 par bucket depuis `s3_bucket_daily`,
- synthèse RI locale depuis `ri_coverage_daily` et `ri_utilization_daily`,
- contrôle qualité des données et jours manquants.

### Frontend

```bash
cd web
npm install
npm run dev
```

### Backend

L'API se trouve dans le répertoire `api/`. Veillez à consulter la documentation interne de l'équipe pour le déploiement.

#### Droits AWS recommandés

Le fichier `api/iam-policy-sample.json` contient un exemple de politique IAM incluant les permissions Cost Explorer nécessaires pour les réservations **et** les Savings Plans (`ce:GetSavingsPlansCoverage` et `ce:GetSavingsPlansUtilization`).

## Automatisation ingestion métriques

Pour automatiser l'import, utilisez la commande auto:

```bash
docker compose --env-file .env run --rm api npm run ingest:metrics:auto
```

Cette commande:

- lit la dernière date importée dans `cost_daily` (par metric),
- repart avec un chevauchement de 1 jour (`-1`) pour rejouer les corrections AWS,
- s'arrête à `J-2` (2 jours de latence),
- exécute ensuite `ingest:metrics` avec la plage calculée.

Mode vue d'ensemble (sans import):

```bash
docker compose --env-file .env run --rm api npm run ingest:metrics:auto:dry
```

Variables optionnelles (dans `.env` ou en argument):

- `INGEST_LAG_DAYS` (défaut `2`)
- `INGEST_OVERLAP_DAYS` (défaut `1`)
- `INGEST_BOOTSTRAP_DAYS` (défaut `30`, utilisé si la table est vide)
- `INGEST_SP_CACHE_WARM` (défaut `true`, préchauffe le cache Savings Plans après ingestion)

Planification automatique (service dédié):

```bash
docker compose --env-file .env --profile automation up -d --build
```

Le service `ingest-scheduler` déclenche `ingest:metrics:auto` tous les jours à l'heure UTC configurée.

Variables scheduler:

- `INGEST_AUTO_AT_UTC` (défaut `03:15`, format `HH:MM`)
- `INGEST_AUTO_RUN_ON_START` (défaut `true`, lance un import au démarrage)
- `INGEST_AUTO_RETRY_MINUTES` (défaut `30`, retry unique après échec)

## Snapshots EC2/EBS exacts

Le profil optionnel `ec2-snapshots` capture `DescribeInstances` et `DescribeVolumes` toutes les heures et stocke uniquement le résultat en PostgreSQL. L'UI lit ensuite `ec2_instance_snapshots` et `ebs_volume_snapshots`; elle ne déclenche pas d'appel AWS pour ces insights.

```bash
docker compose --profile ec2-snapshots up -d --build ec2-snapshot-scheduler
```

Variables utiles:

- `EC2_SNAPSHOT_REGIONS` (défaut `eu-west-3`)
- `EC2_SNAPSHOT_MINUTE` (défaut `5`, minute UTC de chaque heure)
- `EC2_SNAPSHOT_RUN_ON_START` (défaut `false`)

Le tag `VLE_Cost` est stocké s'il existe, mais il n'est pas obligatoire pour compter les états `running`, `stopped` et `terminated` vus au snapshot.

Les coûts EBS sont des estimations mensuelles basées sur les volumes provisionnés: stockage, IOPS provisionnées facturables et throughput gp3 facturable. Les snapshots AWS EBS et les I/O requests des volumes magnetic ne sont pas inclus.

## Optimisation Savings Plans

Les endpoints Savings Plans utilisent maintenant un cache persistant PostgreSQL (`aws_api_cache`) pour éviter un appel AWS à chaque clic.

- Activation: `SP_CACHE_ENABLED=true` (défaut en mode `LOCAL_DB`)
- TTL coverage: `SP_COVERAGE_CACHE_TTL_SECONDS` (défaut `21600`)
- TTL utilization: `SP_UTILIZATION_CACHE_TTL_SECONDS` (défaut `21600`)
- TTL inventory: `SP_INVENTORY_CACHE_TTL_SECONDS` (défaut `21600`)

Commande de préchauffe manuelle:

```bash
docker compose --env-file .env run --rm api npm run ingest:sp:cache
```

## Tests

```bash
cd web
npm run test

cd ../api
npm run test
```
