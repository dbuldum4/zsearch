# zsearch-embed: the helper that turns text into Granite embedding vectors for semantic search.
# Built by scripts/build-embed.sh, which fetches llama.cpp at a pinned tag.
cmake_minimum_required(VERSION 3.16)
project(zsearch_embed C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LLAMA_SOURCE "" CACHE PATH "llama.cpp checkout (scripts/build-embed.sh sets it)")
if(NOT EXISTS "${LLAMA_SOURCE}/CMakeLists.txt")
  message(FATAL_ERROR "LLAMA_SOURCE must point at a llama.cpp checkout; run scripts/build-embed.sh")
endif()

# Only the text library: no tools, no server, no network code, no image or audio encoders.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
foreach(opt LLAMA_BUILD_COMMON LLAMA_BUILD_TESTS LLAMA_BUILD_TOOLS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_SERVER
            LLAMA_BUILD_APP LLAMA_BUILD_UI LLAMA_OPENSSL LLAMA_SUBPROCESS LLAMA_BUILD_MTMD MTMD_VIDEO)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
add_subdirectory("${LLAMA_SOURCE}" llama EXCLUDE_FROM_ALL)

add_executable(zsearch-embed zsearch-embed.cpp)
target_include_directories(zsearch-embed PRIVATE "${LLAMA_SOURCE}/include")
target_link_libraries(zsearch-embed PRIVATE llama)
