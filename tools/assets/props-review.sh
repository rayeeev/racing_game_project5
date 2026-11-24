#!/bin/sh
# Review screenshots of built props: for every asset id given (default: all), both LODs side by side from two angles.
# usage: sh tools/assets/props-review.sh <out-dir> [id ...]      (run from the project root; dev server must be running)
OUT="$1"; shift
HDR=/assets-src/props/_hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr
[ $# -eq 0 ] && set -- concrete_road_barrier modular_electricity_poles street_lamp_01 utility_box_02 old_tyre covered_car Barrel_01 barrel_03 flood_lights portable_generator tool_cart plastic_crate_02 metal_trash_can modular_chainlink_fence modular_wooden_pier wooden_picnic_table
mkdir -p "$OUT"
for id in "$@"; do
	node tools/shot.mjs --url "http://127.0.0.1:5173/dev/preview-props.html?assets=$id&lod=both&hdr=$HDR&envI=0.9&sunI=3.2${EXTRA}" --wait-for "window.__ready === true" \
		--script tools/assets/props-scenario.mjs --out-dir "$OUT" --views "${id}_a:${AZ_A:-28}:${EL_A:-12}:${DIST:-0.62};${id}_b:${AZ_B:-208}:${EL_B:-24}:${DIST:-0.62}" --info 1 2>&1 | grep -E "info|\"ok\"" | cut -c1-900
done
