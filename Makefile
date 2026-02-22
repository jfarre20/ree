# Makefile for srt_compositor
# Requires: ffmpeg development libraries (libavformat, libavcodec, libavutil, libswscale, libswresample)
#           and libsrt support compiled into ffmpeg

CC = gcc
CFLAGS = -Wall -Wextra -O2 -std=c11 -D_GNU_SOURCE
LDFLAGS =

# Use pkg-config for FFmpeg libraries
PKG_LIBS = libavformat libavcodec libavutil libswscale libswresample
PKG_CFLAGS = $(shell pkg-config --cflags $(PKG_LIBS))
PKG_LDFLAGS = $(shell pkg-config --libs $(PKG_LIBS))

CFLAGS += $(PKG_CFLAGS)
LDFLAGS += $(PKG_LDFLAGS) -lpthread -lm

TARGET = srt_compositor
SRCS = srt_compositor.c
OBJS = $(SRCS:.c=.o)

.PHONY: all clean install check-deps

all: check-deps $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) -o $@ $(LDFLAGS)
	@echo ""
	@echo "Build complete: ./$(TARGET)"
	@echo ""

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

check-deps:
	@echo "Checking dependencies..."
	@pkg-config --exists $(PKG_LIBS) || { \
		echo ""; \
		echo "ERROR: FFmpeg development libraries not found!"; \
		echo "Install with:"; \
		echo "  Ubuntu/Debian: sudo apt install libavformat-dev libavcodec-dev libavutil-dev libswscale-dev libswresample-dev"; \
		echo "  Fedora:        sudo dnf install ffmpeg-devel"; \
		echo "  Arch:          sudo pacman -S ffmpeg"; \
		echo ""; \
		echo "Make sure your FFmpeg is built with SRT support (--enable-libsrt)"; \
		echo ""; \
		exit 1; \
	}
	@echo "All dependencies found."

clean:
	rm -f $(OBJS) $(TARGET)

install: $(TARGET)
	install -m 755 $(TARGET) /usr/local/bin/

# Static build (useful for portable binary)
static: check-deps $(SRCS)
	$(CC) $(CFLAGS) $(SRCS) -o $(TARGET) $(shell pkg-config --libs --static $(PKG_LIBS)) -lpthread -lm -static
	@echo "Static build complete: ./$(TARGET)"
