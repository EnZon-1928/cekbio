#!/bin/bash

file=$1
baris_mulai=$2

# cek apakah pengguna memasukkan argumen yang cukup
if [ -z "$file" ] || [ -z "$baris_mulai" ]; then
    echo "cara pakai: ./hapus.sh <nama_file> <baris_awal>"
    echo "contoh: ./hapus.sh target.txt 10"
    exit 1
fi

# cek apakah file target benar-benar ada
if [ ! -f "$file" ]; then
    echo "error: file '$file' tidak ditemukan."
    exit 1
fi

# validasi agar input baris wajib berupa angka
if ! [[ "$baris_mulai" =~ ^[0-9]+$ ]]; then
    echo "error: input baris wajib berupa angka."
    exit 1
fi

# eksekusi penghapusan dari baris ke-N sampai baris terakhir ($)
# parameter -i digunakan agar sed langsung menimpa file asli
sed -i "${baris_mulai},\$d" "$file"

echo "sukses: baris ${baris_mulai} sampai akhir telah dihapus dari $file"

