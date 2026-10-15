# zsearch-embed: the helper that turns text into Granite embedding vectors for semantic search
# (its image path, written for EmbeddingGemma 2, is no longer used by zsearch). Built by scripts/build-embed.sh, which fetches llama.cpp at a pinned tag.
cmake_minimum_required(VERSION 3.16)
project(zsearch_embed C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LLAMA_SOURCE "" CACHE PATH "llama.cpp checkout (scripts/build-embed.sh sets it)")
if(NOT EXISTS "${LLAMA_SOURCE}/CMakeLists.txt")
  message(FATAL_ERROR "LLAMA_SOURCE must point at a llama.cpp checkout; run scripts/build-embed.sh")
endif()

# Only the libraries: no tools, no server, no network code.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
foreach(opt LLAMA_BUILD_COMMON LLAMA_BUILD_TESTS LLAMA_BUILD_TOOLS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_SERVER
            LLAMA_BUILD_APP LLAMA_BUILD_UI LLAMA_OPENSSL LLAMA_SUBPROCESS MTMD_VIDEO)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
set(LLAMA_BUILD_MTMD ON CACHE BOOL "" FORCE)
add_subdirectory("${LLAMA_SOURCE}" llama EXCLUDE_FROM_ALL)

add_executable(zsearch-embed zsearch-embed.cpp)
target_include_directories(zsearch-embed PRIVATE "${LLAMA_SOURCE}/include" "${LLAMA_SOURCE}/tools/mtmd")
target_link_libraries(zsearch-embed PRIVATE llama mtmd)
if(APPLE)
  # Images are decoded with ImageIO, never with the decoders bundled in llama.cpp.
  target_link_libraries(zsearch-embed PRIVATE "-framework ImageIO" "-framework CoreGraphics" "-framework CoreFoundation")
endif()
