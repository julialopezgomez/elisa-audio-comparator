# Elisa Audio Comparator

Web estática, privada por enlace cifrado, para comparar dos tomas de flauta y sus versiones Original/Mejorado. No hay backend, cuentas, analítica, telemetría ni peticiones a terceros.

## Privacidad

GitHub Pages publica únicamente cuatro archivos `.enc`, cifrados individualmente con AES-256-GCM. La clave maestra se transporta en el fragmento `#key=…`: los navegadores no envían ese fragmento al servidor. Tras importarla, la aplicación la conserva solo durante la sesión y retira el fragmento de la barra de direcciones. Los M4A se descifran en memoria y se exponen al reproductor mediante Blob URLs temporales.

`robots.txt` y `noindex,nofollow,noarchive` desaconsejan la indexación, pero **no sustituyen al cifrado**. Cualquiera que reciba el enlace completo puede escuchar el audio.

## Preparación reproducible

Requisitos locales: Python 3 con NumPy, Node 20 o posterior, ffmpeg y ffprobe.

```sh
python3 -m pip install -r requirements.txt
./scripts/prepare.sh --base-url=https://USUARIO.github.io/elisa-audio-comparator/
```

El pipeline:

1. Localiza exactamente las cuatro entradas de `inputs/`.
2. Extrae la pista AAC con `-c:a copy` y comprueba el SHA-256 del payload AAC antes/después.
3. Analiza EBU R128, offsets A/B y waveforms sin modificar los archivos.
4. Alinea los originales mediante chroma STFT y DTW con distancia coseno.
5. Aplica anchors manuales opcionales de `config/manual-anchors.json`.
6. Cifra cada M4A con un IV aleatorio único y verifica el descifrado byte por byte.

La primera ejecución crea `secrets/master-key.base64url` y `secrets/elisa-link.txt`. Las siguientes reutilizan la clave. Solo `--rotate-key` permite sustituirla:

```sh
./scripts/prepare.sh --rotate-key --base-url=https://USUARIO.github.io/elisa-audio-comparator/
```

No se deben compartir, registrar ni añadir a Git los contenidos de `secrets/`.

## Validación

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests
./scripts/check_no_secrets.sh
python3 -m http.server 4173 --directory docs
```

El diagnóstico no publicado se genera en `reports/alignment-diagnostic.svg`. La web usa rutas relativas y está preparada para el subpath de GitHub Pages.

## Publicación con GitHub Pages

El contenido publicable está en `docs/`. En la configuración del repositorio, GitHub Pages debe servir la rama principal desde `/docs` y forzar HTTPS. Antes de cada publicación se debe ejecutar `scripts/check_no_secrets.sh`.

## Límites honestos

La correspondencia entre interpretaciones es aproximada. Se interpola solo entre pares DTW contiguos y monotónicos. Los tramos de confianza baja no producen un tiempo falsamente preciso: la interfaz usa un marcador fiable cercano o desactiva el salto. Los nueve marcadores no tienen nombres musicales inventados.
