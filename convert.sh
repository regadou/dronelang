#!/bin/sh

src=""
dst=""

for i in $@; do
   if [ -z "$dst" ]; then
      dst="$i"
   else
      src="$src $i"
   fi
done

if [ -z "$src" ]; then
   echo "Missing source file"
   echo "Usage: convert.sh <target filename> <source filename> [...]"
else
   cat $src|ffmpeg -i - -an -filter:v "setpts=0.83*PTS" $dst
fi

