#!/bin/zsh
cd -- "$(dirname "$0")"
/usr/bin/python3 launcher.py
if [ "$?" -ne 0 ]; then
  echo "Press Return to close."
  read -r
fi
