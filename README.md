# p5.j5 v2

Pilotez simplement un **Arduino** depuis une page web statique avec la dernière version de **p5.js**. Cette librairie repose sur l'API **Web Serial** et le protocole **Firmata**.

📖 **Documentation et démo**

Cette bibliothèque est une mise à jour de [monteslu/p5.j5](https://github.com/monteslu/p5.j5) (basée sur Johnny-Five).

```
Capteurs / actionneurs ⇄ Arduino (StandardFirmataPlus) ⇄ USB ⇄ navigateur (Web Serial) ⇄ p5.j5 ⇄ sketch p5.js
```

## Accédez à la documentation des composants

Aller voir la page de documentation.


menu à gauche en vertical avec les composants
(mettre en surbrillance le setup de base)

à droite: nom composant - branchement - exemple de code

## Fonctionnalités


| Composant | Classe | Principales fonctions |
|---|---|---|
| Bouton | `five.Button` | `press`, `release`, `hold`, `isDown` |
| Joystick | `five.Joystick` | `x`, `y` (de -1 à 1), `change` |
| Écran LCD I2C | `five.LCD` | `print()`, `clear()`, `cursor()` |
| LED | `five.Led` | `on()`, `off()`, `blink()`, `pulse()`, `brightness()` |
| LED RGB | `five.Led.RGB` | `color()`, `off()`, `strobe()`, `intensity()` |
| Capteur de lumière | `five.Light` | `level` (0-100), `change` |
| Capteur analogique / numérique | `five.Sensor` | `raw`, `value`, `change` |
| Moteur (PWM + direction) | `five.Motor` | `forward()`, `reverse()`, `stop()` |
| Piezo | `five.Piezo` | `tone()`, `noTone()`, `play()` |
| Servomoteur | `five.Servo` | `to()`, `min()`, `max()`, `center()` |

## Démarrage rapide

**1. Préparer la carte** : dans l'IDE Arduino, téléversez *Fichier → Exemples → Firmata → StandardFirmataPlus*, puis fermez le Moniteur série.

**2. Charger les scripts** (p5.js d'abord) :

```html
<script src="https://cdn.jsdelivr.net/npm/p5@2/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/methio/p5.j5@2.0.0/p5.j5.js"></script>
```

Ou téléchargez [`p5.j5.js`](p5.j5.js) et chargez-le localement.

**3. Écrire le sketch** :

```js
let board, led, light;

function setup() {
  createCanvas(400, 300);
  board = createBoard();
  createConnectButton(board);   // le clic ouvre la fenêtre de choix du port

  led = new five.Led(13);
  light = new five.Light("A0");
  board.on("ready", () => led.blink(500));
}

function draw() {
  background(map(light.level, 0, 100, 0, 255));
}
```

Un exemple complet est dans [`examples/basic`](examples/basic/index.html).

## Compatibilité

- **Navigateurs** : Chrome, Edge, Opera (ordinateur). Firefox et Safari ne gèrent pas Web Serial.

## Remerciements

[Luis Montes](https://github.com/monteslu) pour p5.j5, l'équipe [Johnny-Five](https://johnny-five.io/) pour l'API, et le projet [Firmata](https://github.com/firmata/protocol) pour le protocole.

Portage réalisé à l'aide du modèle Sonnet5.5 (librairie et base du readme)