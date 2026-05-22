<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { db } from '$lib/db-client';
  import { isUnitAllowed, getRecommendedUnit } from '$lib/schedule-utils';

  let activeTab = $state<'create' | 'join'>('create');
  
  // Room Creation States
  let title = $state('');
  let rangeDays = $state(7);
  let timeStart = $state('09:00');
  let timeEnd = $state('24:00');
  let displayUnit = $state('1hour');
  let pastPolicy = $state('yesterday');
  let nicknameCreate = $state('');
  let isCreating = $state(false);
  let createError = $state('');

  // Room Join States
  let invitationCode = $state('');
  let nicknameJoin = $state('');
  let isJoining = $state(false);
  let joinError = $state('');

  // Validate allowed units reactively
  let unitAllowed = $derived(isUnitAllowed(timeStart, timeEnd, displayUnit));
  let recommendedUnit = $derived(getRecommendedUnit(timeStart, timeEnd));

  onMount(() => {
    // Check if code was provided in the query string
    const code = page.url.searchParams.get('code');
    if (code) {
      invitationCode = code;
      activeTab = 'join';
    }
  });

  function getRandomVibrantColor(): string {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue}, 80%, 55%)`; // iOS style vibrant pastel hue
  }

  // Create Room handler
  async function handleCreateRoom(e: Event) {
    e.preventDefault();
    if (!title.trim() || !nicknameCreate.trim()) {
      createError = '모든 필드를 입력해 주세요.';
      return;
    }

    isCreating = true;
    createError = '';

    let finalUnit = displayUnit;
    if (!isUnitAllowed(timeStart, timeEnd, displayUnit)) {
      finalUnit = getRecommendedUnit(timeStart, timeEnd);
    }

    try {
      const { data: roomData, error: roomError } = await db
        .from('rooms')
        .insert({
          title: title.trim(),
          range_days: rangeDays,
          time_start: timeStart,
          time_end: timeEnd,
          display_unit: finalUnit,
          past_policy: pastPolicy
        })
        .select()
        .single();

      if (roomError) throw roomError;

      const hostColor = getRandomVibrantColor();
      const { data: partData, error: partError } = await db
        .from('participants')
        .insert({
          room_id: roomData.id,
          nickname: nicknameCreate.trim(),
          color: hostColor
        })
        .select()
        .single();

      if (partError) throw partError;

      localStorage.setItem(`room_session_${roomData.id}`, JSON.stringify({
        participant_id: partData.id,
        nickname: partData.nickname,
        color: partData.color
      }));

      goto(`/room/${roomData.id}`);
    } catch (err: any) {
      console.error(err);
      createError = err.message || '방을 만드는 도중 에러가 발생했습니다.';
    } finally {
      isCreating = false;
    }
  }

  // Join Room handler
  async function handleJoinRoom(e: Event) {
    e.preventDefault();
    const cleanCode = invitationCode.trim();
    if (!cleanCode || !nicknameJoin.trim()) {
      joinError = '초대 코드와 닉네임을 모두 입력해 주세요.';
      return;
    }

    isJoining = true;
    joinError = '';

    try {
      const { data: roomData, error: roomError } = await db
        .from('rooms')
        .select('id')
        .eq('id', cleanCode)
        .maybeSingle();

      if (roomError) throw roomError;
      if (!roomData) {
        joinError = '방을 찾을 수 없습니다. 초대 코드를 확인해 주세요.';
        isJoining = false;
        return;
      }

      const joinColor = getRandomVibrantColor();
      const { data: partData, error: partError } = await db
        .from('participants')
        .insert({
          room_id: roomData.id,
          nickname: nicknameJoin.trim(),
          color: joinColor
        })
        .select()
        .single();

      if (partError) throw partError;

      localStorage.setItem(`room_session_${roomData.id}`, JSON.stringify({
        participant_id: partData.id,
        nickname: partData.nickname,
        color: partData.color
      }));

      goto(`/room/${roomData.id}`);
    } catch (err: any) {
      console.error(err);
      joinError = err.message || '방에 입장하는 데 실패했습니다.';
    } finally {
      isJoining = false;
    }
  }
</script>

<div class="app-container min-h-screen bg-gray-50 flex flex-col justify-between">
  <div class="flex-1 flex flex-col justify-center px-6 py-12">
    <!-- Hero / Title -->
    <header class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl mb-4">
        <span class="text-3xl">⏳</span>
      </div>
      <h1 class="text-2xl font-extrabold tracking-tight text-gray-900">suji</h1>
      <p class="text-sm text-gray-500 mt-1">간편하게 겹치는 일정을 확인하는 시각화 도구</p>
    </header>

    <!-- iOS style Segmented Control (Tabs) -->
    <div class="bg-gray-200/80 p-0.5 rounded-xl flex mb-6">
      <button 
        type="button"
        class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all {activeTab === 'create' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}"
        onclick={() => activeTab = 'create'}
      >
        새 방 만들기
      </button>
      <button 
        type="button"
        class="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all {activeTab === 'join' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}"
        onclick={() => activeTab = 'join'}
      >
        참여하기
      </button>
    </div>

    <!-- Forms Card -->
    <div class="bg-white border border-gray-100 rounded-3xl p-6 shadow-sm">
      {#if activeTab === 'create'}
        <form onsubmit={handleCreateRoom} class="space-y-4">
          <div>
            <label for="title" class="block text-xs font-semibold text-gray-500 mb-1.5">모임 이름</label>
            <input 
              id="title"
              type="text" 
              bind:value={title} 
              placeholder="예: 격전 대기방, 주말 스터디" 
              class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
              required 
            />
          </div>

          <div>
            <label for="nickname-create" class="block text-xs font-semibold text-gray-500 mb-1.5">내 닉네임</label>
            <input 
              id="nickname-create"
              type="text" 
              bind:value={nicknameCreate} 
              placeholder="예: 꼬북이" 
              class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
              required 
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="range-days" class="block text-xs font-semibold text-gray-500 mb-1.5">표시 기간</label>
              <select id="range-days" bind:value={rangeDays} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                {#each Array.from({length: 30}, (_, i) => i + 1) as day}
                  <option value={day}>{day}일 동안</option>
                {/each}
              </select>
            </div>

            <div>
              <label for="past-policy" class="block text-xs font-semibold text-gray-500 mb-1.5">과거 일정</label>
              <select id="past-policy" bind:value={pastPolicy} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                <option value="today">오늘부터 표시</option>
                <option value="yesterday">어제만 유지 (접힘)</option>
                <option value="7days">최근 7일 유지</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="time-start" class="block text-xs font-semibold text-gray-500 mb-1.5">시작 시간</label>
              <select id="time-start" bind:value={timeStart} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                {#each Array.from({length: 24}) as _, h}
                  {@const timeStr = `${String(h).padStart(2, '0')}:00`}
                  <option value={timeStr}>{timeStr}</option>
                {/each}
              </select>
            </div>

            <div>
              <label for="time-end" class="block text-xs font-semibold text-gray-500 mb-1.5">종료 시간</label>
              <select id="time-end" bind:value={timeEnd} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
                {#each Array.from({length: 24}, (_, i) => i + 1) as h}
                  {@const timeStr = `${String(h).padStart(2, '0')}:00`}
                  <option value={timeStr}>{timeStr}</option>
                {/each}
              </select>
            </div>
          </div>

          <div>
            <label for="display-unit" class="block text-xs font-semibold text-gray-500 mb-1.5">시간 표시 단위</label>
            <select id="display-unit" bind:value={displayUnit} class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 transition-all">
              <option value="15min">15분 단위</option>
              <option value="30min">30분 단위</option>
              <option value="1hour">1시간 단위</option>
              <option value="3hour">3시간 단위</option>
              <option value="6hour">6시간 단위</option>
              <option value="1day">하루 단위</option>
            </select>
            {#if !unitAllowed}
              <div class="mt-2 text-[11px] leading-relaxed text-amber-600 bg-amber-50 border border-amber-200/50 p-2.5 rounded-lg">
                ⚠️ 선택하신 시간 범위에는 해당 단위를 설정할 수 없어, 저장 시 <strong>{recommendedUnit === '15min' ? '15분' : recommendedUnit === '30min' ? '30분' : '1시간'} 단위</strong>로 자동 조정됩니다.
              </div>
            {/if}
          </div>

          {#if createError}
            <div class="text-xs text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-xl text-center">
              {createError}
            </div>
          {/if}

          <button 
            type="submit" 
            class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            disabled={isCreating}
          >
            {#if isCreating}방 생성 중...{:else}방 만들기 & 입장{/if}
          </button>
        </form>
      {:else}
        <form onsubmit={handleJoinRoom} class="space-y-4">
          <div>
            <label for="invitation-code" class="block text-xs font-semibold text-gray-500 mb-1.5">초대 코드 (방 ID)</label>
            <input 
              id="invitation-code"
              type="text" 
              bind:value={invitationCode} 
              placeholder="공유받은 초대코드 붙여넣기" 
              class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
              required 
            />
          </div>

          <div>
            <label for="nickname-join" class="block text-xs font-semibold text-gray-500 mb-1.5">내 닉네임</label>
            <input 
              id="nickname-join"
              type="text" 
              bind:value={nicknameJoin} 
              placeholder="예: 홍길동" 
              class="w-full bg-gray-50 border border-gray-200/70 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
              required 
            />
          </div>

          {#if joinError}
            <div class="text-xs text-rose-600 bg-rose-50 border border-rose-100 p-2.5 rounded-xl text-center">
              {joinError}
            </div>
          {/if}

          <button 
            type="submit" 
            class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
            disabled={isJoining}
          >
            {#if isJoining}입장 처리 중...{:else}모임 방 입장{/if}
          </button>
        </form>
      {/if}
    </div>
  </div>

  <footer class="py-6 text-center text-[10px] text-gray-400">
    &copy; {new Date().getFullYear()} suji. All rights reserved.
  </footer>
</div>
