# Laundry Card

Carte Lovelace Home Assistant pour lave-linge et sèche-linge.

## Fonctionnalités

- Détection automatique des cycles depuis l'historique de puissance
- Durée du cycle en cours
- Cycles de la semaine et du mois
- Coût de la semaine et du mois
- Consommation du cycle en cours
- Prix du kWh configurable dans l'éditeur
- Aucun capteur/helper supplémentaire
- Éditeur graphique Home Assistant
- Courant et puissance non affichés

## Installation HACS

Ajoutez le dépôt comme **Custom repository** dans HACS, catégorie **Dashboard**. Puis installez `Laundry Card`.

## Ressource

HACS ajoute normalement la ressource automatiquement. Sinon ajoutez `/hacsfiles/laundry-card/laundry-card.js` en ressource JavaScript de type module.

## Configuration

Ajoutez la carte depuis l'interface Home Assistant et sélectionnez les entités dans l'éditeur graphique.

La configuration YAML équivalente est :

```yaml
type: custom:laundry-card
price_per_kwh: 0.25
detection:
  start_power: 10
  stop_power: 5
  stop_delay: 180
  min_cycle_duration: 60
laundry:
  name: Lave-linge
  power: sensor.lave_linge_power
  energy: sensor.lave_linge_energy
  current: sensor.lave_linge_current
dryer:
  name: Sèche-linge
  power: sensor.seche_linge_power
  energy: sensor.seche_linge_energy
  current: sensor.seche_linge_current
```

## Notes

La carte interroge l'API historique de Home Assistant. Pour compter les cycles et calculer leur consommation, le Recorder doit conserver l'historique des entités concernées.
